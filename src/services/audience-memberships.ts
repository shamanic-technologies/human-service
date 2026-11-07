// Brand-scoped membership reads: which audiences (hence which lists / sourcing
// origins) FOUND each person, and per audience how many of its people another
// audience found too. Owner 2026-10-08: a person found by several sources is a
// higher-intent lead, and we want to measure that.
//
// RAW membership on purpose: no deprecated -> canonical collapse (unlike
// POST /orgs/audiences/stats). A person served from a retired "<x> [Apify]"
// audience stays credited to that audience (list apify_search), so a consumer
// attributing people to lists never hands Apify's people to Apollo Cold Filters.
// Every audience of the brand, any status, since inception. Membership
// provenance ('served' | 'found_taken') is explained in audience-provenance.ts.
//
// Pure DB read: no provider call, no spend.
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audienceMembers, audiences, googleMapsBrandClaims, humanIdentities, humanIdentityKeys, people } from "../db/schema.js";
import { audienceListKind } from "./audience-snapshot.js";
import { normalizeEmail } from "./suppression.js";
import { emailsOfPersons, personIdsByEmail, type PersonEmailView } from "./person-emails.js";
import { canonicalOf, InvalidIdentityKeyError, normalizePhone } from "./human-identity.js";

export interface MembershipScope {
  brandId: string;
  orgId?: string;
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

async function loadBrandAudiences(scope: MembershipScope) {
  const where = scope.orgId
    ? and(eq(audiences.brandId, scope.brandId), eq(audiences.orgId, scope.orgId))
    : eq(audiences.brandId, scope.brandId);
  const list = await db.select().from(audiences).where(where);
  return new Map(list.map((a) => [a.id, a]));
}

function audFilter(scope: MembershipScope) {
  return scope.orgId
    ? sql`a.brand_id = ${scope.brandId} and a.org_id = ${scope.orgId}`
    : sql`a.brand_id = ${scope.brandId}`;
}

const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

// Per person: every audience of the brand that found them. Paged by person,
// stable order on person id.
export async function brandMemberships(
  scope: MembershipScope,
  page: { limit: number; offset: number }
) {
  const auds = await loadBrandAudiences(scope);
  const [totalRow] = await rows<{ total: unknown }>(sql`
    select count(distinct m.person_id) as total
    from audience_members m join audiences a on a.id = m.audience_id
    where ${audFilter(scope)}`);
  const found = await rows<{
    person_id: string;
    org_id: string;
    email_norm: string | null;
    audience_id: string;
    provenance: string;
    joined_at: unknown;
  }>(sql`
    with pg as (
      select distinct m.person_id
      from audience_members m join audiences a on a.id = m.audience_id
      where ${audFilter(scope)}
      order by m.person_id
      limit ${page.limit} offset ${page.offset}
    )
    select m.person_id, p.org_id, p.email_norm, m.audience_id, m.provenance, m.joined_at
    from audience_members m
    join pg on pg.person_id = m.person_id
    join audiences a on a.id = m.audience_id
    join people p on p.id = m.person_id
    where ${audFilter(scope)}
    order by m.person_id, m.joined_at, m.audience_id`);

  const out = new Map<
    string,
    {
      personId: string;
      orgId: string;
      emailNorm: string | null;
      emails: PersonEmailView[];
      memberships: Array<{
        audienceId: string;
        offerId: string | null;
        list: ReturnType<typeof audienceListKind>;
        status: string;
        provenance: string;
        joinedAt: string;
      }>;
    }
  >();
  for (const r of found) {
    const a = auds.get(r.audience_id);
    // Scoped by the same filter in SQL, so every audience is loaded.
    if (!a) throw new Error(`audience ${r.audience_id} missing from brand scope`);
    const person = out.get(r.person_id) ?? {
      personId: r.person_id,
      orgId: r.org_id,
      emailNorm: r.email_norm,
      emails: [],
      memberships: [],
    };
    person.memberships.push({
      audienceId: a.id,
      offerId: a.offerId,
      list: audienceListKind(a),
      status: a.status,
      provenance: r.provenance,
      joinedAt: iso(r.joined_at),
    });
    out.set(r.person_id, person);
  }
  // Every address of each person (person-emails.ts), primary first.
  const emails = await emailsOfPersons(db, [...out.keys()]);
  for (const p of out.values()) p.emails = emails.get(p.personId) ?? [];
  return {
    brandId: scope.brandId,
    total: Number(totalRow?.total ?? 0),
    limit: page.limit,
    offset: page.offset,
    people: [...out.values()],
  };
}

// Per audience: how many of its people another audience / another LIST of the
// brand found too, plus the brand-level count of multi-source people.
export async function brandAudienceOverlap(scope: MembershipScope) {
  const auds = await loadBrandAudiences(scope);
  const members = await rows<{ audience_id: string; person_id: string; provenance: string }>(sql`
    select m.audience_id, m.person_id, m.provenance
    from audience_members m join audiences a on a.id = m.audience_id
    where ${audFilter(scope)}`);

  const audsOf = new Map<string, Set<string>>();
  const listsOf = new Map<string, Set<string>>();
  for (const m of members) {
    const a = auds.get(m.audience_id);
    if (!a) throw new Error(`audience ${m.audience_id} missing from brand scope`);
    const s = audsOf.get(m.person_id) ?? new Set<string>();
    s.add(m.audience_id);
    audsOf.set(m.person_id, s);
    const l = listsOf.get(m.person_id) ?? new Set<string>();
    l.add(audienceListKind(a) ?? "none");
    listsOf.set(m.person_id, l);
  }

  const per = new Map<
    string,
    { member: number; served: number; foundTaken: number; otherAudience: number; otherList: number }
  >();
  for (const m of members) {
    const c = per.get(m.audience_id) ?? {
      member: 0,
      served: 0,
      foundTaken: 0,
      otherAudience: 0,
      otherList: 0,
    };
    c.member += 1;
    if (m.provenance === "served") c.served += 1;
    if (m.provenance === "found_taken") c.foundTaken += 1;
    if ((audsOf.get(m.person_id)?.size ?? 0) > 1) c.otherAudience += 1;
    if ((listsOf.get(m.person_id)?.size ?? 0) > 1) c.otherList += 1;
    per.set(m.audience_id, c);
  }

  let multiAudience = 0;
  let multiList = 0;
  for (const [pid, s] of audsOf) {
    if (s.size > 1) multiAudience += 1;
    if ((listsOf.get(pid)?.size ?? 0) > 1) multiList += 1;
  }

  return {
    brandId: scope.brandId,
    people: audsOf.size,
    peopleInSeveralAudiences: multiAudience,
    peopleInSeveralLists: multiList,
    audiences: [...auds.values()]
      .map((a) => {
        const c = per.get(a.id);
        return {
          audienceId: a.id,
          name: a.name,
          orgId: a.orgId,
          offerId: a.offerId,
          list: audienceListKind(a),
          status: a.status,
          memberCount: c?.member ?? 0,
          servedCount: c?.served ?? 0,
          foundTakenCount: c?.foundTaken ?? 0,
          alsoInOtherAudienceCount: c?.otherAudience ?? 0,
          alsoInOtherListCount: c?.otherList ?? 0,
        };
      })
      .sort((x, y) => y.memberCount - x.memberCount || x.name.localeCompare(y.name)),
  };
}

// Same membership rows as brandMemberships, keyed by EMAIL (ANY address of the
// person, see person-emails.ts) for a caller that holds leads, not person ids (lead-service: a page of 20-50 leads, or a whole-brand
// walk of tens of thousands, in one server-to-server call). Every requested email
// comes back as a key (raw, as sent): null when this org holds no person for it,
// else the person and every audience of the brand that found them ([] when none).
const EMAIL_CHUNK = 10_000; // well under Postgres' 65,535 bind-parameter cap

export async function brandMembershipsByEmail(
  scope: { brandId: string; orgId: string },
  emails: string[]
) {
  const auds = await loadBrandAudiences(scope);
  const normOf = new Map(emails.map((e) => [e, normalizeEmail(e)]));
  const norms = [...new Set([...normOf.values()].filter((x): x is string => x !== null))];

  const personByNorm = new Map<string, string>();
  const membershipsByPerson = new Map<
    string,
    Array<{
      audienceId: string;
      offerId: string | null;
      list: ReturnType<typeof audienceListKind>;
      status: string;
      provenance: string;
      joinedAt: string;
    }>
  >();
  for (let i = 0; i < norms.length; i += EMAIL_CHUNK) {
    const chunk = norms.slice(i, i + EMAIL_CHUNK);
    // ANY address of the person resolves to them (person-emails.ts).
    const found = await personIdsByEmail(db, scope.orgId, chunk);
    for (const [norm, id] of found) personByNorm.set(norm, id);
    const ids = [...new Set(found.values())];
    if (ids.length === 0) continue;
    const rows = await db
      .select({
        personId: audienceMembers.personId,
        audienceId: audienceMembers.audienceId,
        provenance: audienceMembers.provenance,
        joinedAt: audienceMembers.joinedAt,
      })
      .from(audienceMembers)
      .innerJoin(audiences, eq(audiences.id, audienceMembers.audienceId))
      .where(
        and(
          eq(audiences.brandId, scope.brandId),
          eq(audiences.orgId, scope.orgId),
          inArray(audienceMembers.personId, ids)
        )
      )
      .orderBy(audienceMembers.joinedAt, audienceMembers.audienceId);
    for (const r of rows) {
      const a = auds.get(r.audienceId);
      if (!a) throw new Error(`audience ${r.audienceId} missing from brand scope`);
      const list = membershipsByPerson.get(r.personId) ?? [];
      list.push({
        audienceId: a.id,
        offerId: a.offerId,
        list: audienceListKind(a),
        status: a.status,
        provenance: r.provenance,
        joinedAt: r.joinedAt.toISOString(),
      });
      membershipsByPerson.set(r.personId, list);
    }
  }

  const emailsByPerson = await emailsOfPersons(db, [...new Set(personByNorm.values())]);
  const byEmail: Record<
    string,
    {
      personId: string;
      emails: PersonEmailView[];
      memberships: NonNullable<ReturnType<typeof membershipsByPerson.get>>;
    } | null
  > = {};
  for (const [raw, norm] of normOf) {
    const personId = norm ? personByNorm.get(norm) : undefined;
    byEmail[raw] = personId
      ? {
          personId,
          emails: emailsByPerson.get(personId) ?? [],
          memberships: membershipsByPerson.get(personId) ?? [],
        }
      : null;
  }
  return { brandId: scope.brandId, byEmail };
}

// --- Same read, keyed by PHONE or by PERSON / HUMAN id (AUDIENCE-PER-OFFER-1107) ---
//
// crm-service places a form fill / WhatsApp message on the offer that already
// reached the person ("a person is contacted for one offer of a brand only"). By
// email it asks brandMembershipsByEmail above; a fill with only a phone, or a
// person known only by its id, is answered here on the SAME membership rows (same
// provenance, same oldest-first order), so the caller's "reached" rule
// (provenance served, earliest wins) reads identically whatever key it holds.
//
// A phone or a human can stand for SEVERAL persons of the org (one human, two
// mailboxes = two `people` rows): the entry merges their memberships, each row
// naming its personId, oldest first.

type Membership = {
  audienceId: string;
  offerId: string | null;
  list: ReturnType<typeof audienceListKind>;
  status: string;
  provenance: string;
  joinedAt: string;
};
type PersonMembership = Membership & { personId: string };

const PERSON_CHUNK = 10_000;

// Every membership of the given persons in the brand's audiences, oldest first.
async function membershipsOfPersons(
  scope: { brandId: string; orgId: string },
  personIds: string[]
): Promise<PersonMembership[]> {
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return [];
  const auds = await loadBrandAudiences(scope);
  const out: PersonMembership[] = [];
  for (let i = 0; i < ids.length; i += PERSON_CHUNK) {
    const found = await db
      .select({
        personId: audienceMembers.personId,
        audienceId: audienceMembers.audienceId,
        provenance: audienceMembers.provenance,
        joinedAt: audienceMembers.joinedAt,
      })
      .from(audienceMembers)
      .innerJoin(audiences, eq(audiences.id, audienceMembers.audienceId))
      .where(
        and(
          eq(audiences.brandId, scope.brandId),
          eq(audiences.orgId, scope.orgId),
          inArray(audienceMembers.personId, ids.slice(i, i + PERSON_CHUNK))
        )
      );
    for (const r of found) {
      const a = auds.get(r.audienceId);
      if (!a) throw new Error(`audience ${r.audienceId} missing from brand scope`);
      out.push({
        personId: r.personId,
        audienceId: a.id,
        offerId: a.offerId,
        list: audienceListKind(a),
        status: a.status,
        provenance: r.provenance,
        joinedAt: r.joinedAt.toISOString(),
      });
    }
  }
  return out.sort(
    (x, y) => x.joinedAt.localeCompare(y.joinedAt) || x.audienceId.localeCompare(y.audienceId)
  );
}

// The org's persons of one human: every `people` row whose atomic human is in the
// component the org sees (merges and splits it can see), plus the canonical id.
async function personsOfHuman(orgId: string, humanId: string) {
  const { humanId: canonical, memberHumanIds } = await canonicalOf(db, humanId, orgId);
  const rows = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.orgId, orgId), inArray(people.humanId, memberHumanIds)));
  return { humanId: canonical, personIds: rows.map((r) => r.id) };
}

export interface KeyedMemberships {
  humanId: string | null;
  personIds: string[];
  memberships: PersonMembership[];
}

// Per PHONE (E.164, any common spelling): the org's persons at that number, from
// the two places a phone names a person: the fleet human holding the phone key
// (WhatsApp contacts, CRM records, signups resolved here), and the business a
// Google Maps audience of the org served at that number. null = no person of the
// org at that number (or the value is not an E.164 phone).
export async function brandMembershipsByPhone(
  scope: { brandId: string; orgId: string },
  phones: string[]
) {
  const byPhone: Record<string, KeyedMemberships | null> = {};
  for (const raw of phones) {
    if (raw in byPhone) continue;
    let norm: string;
    try {
      norm = normalizePhone(raw);
    } catch (err) {
      if (err instanceof InvalidIdentityKeyError) {
        byPhone[raw] = null;
        continue;
      }
      throw err;
    }
    const personIds = new Set<string>();
    let humanId: string | null = null;
    const [key] = await db
      .select({ humanId: humanIdentityKeys.humanId })
      .from(humanIdentityKeys)
      .where(and(eq(humanIdentityKeys.kind, "phone"), eq(humanIdentityKeys.valueNorm, norm)))
      .limit(1);
    if (key) {
      const h = await personsOfHuman(scope.orgId, key.humanId);
      humanId = h.humanId;
      for (const id of h.personIds) personIds.add(id);
    }
    const claims = await db
      .select({ personId: googleMapsBrandClaims.personId })
      .from(googleMapsBrandClaims)
      .where(
        and(
          eq(googleMapsBrandClaims.orgId, scope.orgId),
          eq(googleMapsBrandClaims.phoneE164, norm),
          isNotNull(googleMapsBrandClaims.personId)
        )
      );
    for (const c of claims) if (c.personId) personIds.add(c.personId);
    byPhone[raw] =
      personIds.size === 0
        ? null
        : {
            humanId,
            personIds: [...personIds].sort(),
            memberships: await membershipsOfPersons(scope, [...personIds]),
          };
  }
  return { brandId: scope.brandId, byPhone };
}

// Per PERSON id (the `people` id serve-next / by-email return) and per HUMAN id
// (the fleet id /humans/resolve returns). A person id outside the org, or a human
// with no person in the org, is null; an unknown human id is null too.
export async function brandMembershipsByPerson(
  scope: { brandId: string; orgId: string },
  ids: { personIds: string[]; humanIds: string[] }
) {
  const personIds = [...new Set(ids.personIds)];
  const known = personIds.length
    ? await db
        .select({ id: people.id, humanId: people.humanId })
        .from(people)
        .where(and(eq(people.orgId, scope.orgId), inArray(people.id, personIds)))
    : [];
  const knownIds = known.map((p) => p.id);
  const [emails, memberships] = await Promise.all([
    emailsOfPersons(db, knownIds),
    membershipsOfPersons(scope, knownIds),
  ]);
  const byPersonId: Record<
    string,
    { personId: string; humanId: string | null; emails: PersonEmailView[]; memberships: Membership[] } | null
  > = {};
  for (const id of personIds) byPersonId[id] = null;
  for (const p of known) {
    byPersonId[p.id] = {
      personId: p.id,
      humanId: p.humanId ? (await canonicalOf(db, p.humanId, scope.orgId)).humanId : null,
      emails: emails.get(p.id) ?? [],
      memberships: memberships
        .filter((m) => m.personId === p.id)
        .map(({ personId: _p, ...m }) => m),
    };
  }

  const byHumanId: Record<string, KeyedMemberships | null> = {};
  for (const hid of new Set(ids.humanIds)) {
    const [exists] = await db
      .select({ id: humanIdentities.id })
      .from(humanIdentities)
      .where(eq(humanIdentities.id, hid))
      .limit(1);
    if (!exists) {
      byHumanId[hid] = null;
      continue;
    }
    const h = await personsOfHuman(scope.orgId, hid);
    byHumanId[hid] =
      h.personIds.length === 0
        ? null
        : { humanId: h.humanId, personIds: h.personIds.sort(), memberships: await membershipsOfPersons(scope, h.personIds) };
  }
  return { brandId: scope.brandId, byPersonId, byHumanId };
}
