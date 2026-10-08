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
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences } from "../db/schema.js";
import { audienceListKind } from "./audience-snapshot.js";

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
