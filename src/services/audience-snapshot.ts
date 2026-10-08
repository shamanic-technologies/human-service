// Staff snapshot of what a brand HOLDS in its audiences: the people and the
// companies each list actually brought in, and which target audiences (the text
// the pre-pay screen judges against) accepted them. A pure read of rows this
// service already wrote: no provider call, no spend, no new state.
//
// "Held" = every person a list of the brand handed us, at any stage:
//   - revealed:  a served person (audience_members -> people), email bought;
//   - screened:  a free teaser the pre-pay screen judged (latest verdict per
//                audience + person in audience_teaser_screenings);
//   - buffered:  a free teaser waiting in audience_teaser_buffer, not judged yet.
// One person is keyed on the provider person id (the apollo id rides both the
// teaser and the revealed person), so a teaser that was later revealed counts
// once. A revealed person with no provider id keys on its people.id.
//
// "Accepted" = the audience's LATEST verdict on that person passes the CURRENT
// bar: yes-probability > SCREEN_MIN_YES_PROBABILITY. A verdict taken under an
// older, stricter bar is re-read at today's bar, since the question is "does the
// target accept them now". v1 rows carry no probability: their boolean verdict
// stands. A person never screened (revealed before the screen shipped, or still
// buffered) is neither accepted nor rejected.
//
// Companies: a revealed person carries the employer's DOMAIN but no name, a
// teaser carries the NAME but no domain. A screened-then-revealed person holds
// both, which gives a name -> domain map for the brand, so a teaser-only person
// at a company we know the domain of lands on that same company. Otherwise the
// company is keyed by its lowercased name. A person with neither is counted in
// no company.
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences } from "../db/schema.js";
import { isLinkedinEngagementFilters } from "../lib/apollo-audiences.js";
import { SCREEN_MIN_YES_PROBABILITY } from "./teaser-screening.js";
import type { AUDIENCE_LIST_KINDS } from "../schemas.js";

type AudienceListKind = (typeof AUDIENCE_LIST_KINDS)[number];

// What list an audience row holds. null = no committed provider, no list.
export function audienceListKind(row: {
  provider: string | null;
  filters: unknown;
}): AudienceListKind | null {
  if (!row.provider) return null;
  if (row.provider === "crm") return "crm_contacts";
  if (row.provider === "apify") return "apify_search";
  if (isLinkedinEngagementFilters(row.filters)) return "linkedin_engagement";
  return hasBuyingSignal(row.filters) ? "apollo_buying_signal" : "apollo_search";
}

function hasBuyingSignal(filters: unknown): boolean {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return false;
  const s = (filters as Record<string, unknown>).buying_signal;
  return !!s && typeof s === "object" && !Array.isArray(s) &&
    typeof (s as Record<string, unknown>).type === "string";
}

export interface SnapshotScope {
  brandId: string;
  orgId?: string;
}

type AudienceRow = typeof audiences.$inferSelect;

// One row per (audience, person) the brand holds, with its company key. Every
// read below aggregates this one relation, so the three surfaces cannot disagree.
function heldSql(scope: SnapshotScope) {
  const orgFilter = scope.orgId ? sql`and a.org_id = ${scope.orgId}` : sql``;
  return sql`
    aud as (
      select a.id, a.org_id from audiences a
      where a.brand_id = ${scope.brandId} ${orgFilter}
    ),
    scr as (
      select distinct on (s.audience_id, s.provider_person_id)
        s.audience_id, s.provider_person_id, s.teaser, s.yes_probability,
        case when s.yes_probability is not null
          then s.yes_probability > ${SCREEN_MIN_YES_PROBABILITY}
          else s.verdict end as accepted
      from audience_teaser_screenings s join aud on aud.id = s.audience_id
      order by s.audience_id, s.provider_person_id, s.created_at desc
    ),
    src as (
      select m.audience_id,
        coalesce(p.apollo_person_id, p.apify_person_id, 'person:' || p.id::text) as person_key,
        p.id as person_id, 'revealed' as stage,
        coalesce(p.full_name, nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '')) as name,
        p.title, p.company_name as org_name, lower(p.company_domain) as org_domain,
        null::boolean as accepted, null::double precision as yes_probability
      from audience_members m
      join aud on aud.id = m.audience_id
      join people p on p.id = m.person_id
      -- what THIS list revealed; a person it only found while taken
      -- (multi-source, audience-memberships.ts) was bought by another list
      where m.provenance = 'served'
      union all
      select scr.audience_id, scr.provider_person_id, null, 'screened',
        scr.teaser->>'name', scr.teaser->>'title', scr.teaser->>'organizationName', null,
        scr.accepted, scr.yes_probability
      from scr
      union all
      select b.audience_id, b.provider_person_id, null, 'buffered',
        b.teaser->>'name', b.teaser->>'title', b.teaser->>'organizationName', null,
        null, null
      from audience_teaser_buffer b join aud on aud.id = b.audience_id
    ),
    held as (
      select audience_id, person_key,
        max(person_id::text) as person_id,
        bool_or(stage = 'revealed') as revealed,
        bool_or(stage = 'screened') as screened,
        bool_or(stage = 'buffered') as buffered,
        bool_or(accepted) filter (where stage = 'screened') as accepted,
        max(yes_probability) as yes_probability,
        max(name) as name, max(title) as title,
        max(nullif(trim(org_name), '')) as org_name, max(org_domain) as org_domain
      from src group by audience_id, person_key
    ),
    person_org as (
      select person_key, max(nullif(trim(org_name), '')) as org_name, max(org_domain) as org_domain
      from held group by person_key
    ),
    name_domain as (
      select lower(org_name) as lname, min(org_domain) as domain
      from person_org where org_name is not null and org_domain is not null
      group by lower(org_name)
    ),
    keyed as (
      select h.*,
        coalesce(po.org_domain, nd.domain) as company_domain,
        coalesce(po.org_name, nd2.org_name) as company_name,
        case
          when coalesce(po.org_domain, nd.domain) is not null then 'domain:' || coalesce(po.org_domain, nd.domain)
          when po.org_name is not null then 'name:' || lower(po.org_name)
          else null end as company_key
      from held h
      join person_org po on po.person_key = h.person_key
      left join name_domain nd on nd.lname = lower(po.org_name)
      left join lateral (
        select max(p2.org_name) as org_name from person_org p2
        where po.org_name is null and p2.org_domain = po.org_domain and p2.org_name is not null
      ) nd2 on true
    )`;
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

async function loadAudiences(scope: SnapshotScope): Promise<Map<string, AudienceRow>> {
  const where = scope.orgId
    ? and(eq(audiences.brandId, scope.brandId), eq(audiences.orgId, scope.orgId))
    : eq(audiences.brandId, scope.brandId);
  const list = await db.select().from(audiences).where(where);
  return new Map(list.map((a) => [a.id, a]));
}

function audienceRef(a: AudienceRow | undefined, id: string) {
  return {
    audienceId: id,
    name: a?.name ?? null,
    status: a?.status ?? null,
    list: a ? audienceListKind(a) : null,
  };
}

const n = (v: unknown) => Number(v ?? 0);

function counts(r: Record<string, unknown> | undefined) {
  return {
    people: {
      held: n(r?.people_held),
      revealed: n(r?.people_revealed),
      screened: n(r?.people_screened),
      accepted: n(r?.people_accepted),
      rejected: n(r?.people_rejected),
      waiting: n(r?.people_waiting),
    },
    companies: {
      held: n(r?.companies_held),
      revealed: n(r?.companies_revealed),
      accepted: n(r?.companies_accepted),
    },
  };
}

// 1. Per audience (list): what it brought in, people and companies.
export async function brandAudienceSnapshot(scope: SnapshotScope) {
  const auds = await loadAudiences(scope);
  // One pass: a row per audience plus the brand total (grouping set ()), where
  // a person or company held by several lists counts once.
  const grouped = await rows<Record<string, unknown>>(sql`
    with ${heldSql(scope)}
    select audience_id, grouping(audience_id) as is_total,
      count(distinct person_key) as people_held,
      count(distinct person_key) filter (where revealed) as people_revealed,
      count(distinct person_key) filter (where screened) as people_screened,
      count(distinct person_key) filter (where accepted) as people_accepted,
      count(distinct person_key) filter (where screened and not accepted) as people_rejected,
      count(distinct person_key) filter (where buffered and not screened and not revealed) as people_waiting,
      count(distinct company_key) as companies_held,
      count(distinct company_key) filter (where accepted) as companies_accepted,
      count(distinct company_key) filter (where revealed) as companies_revealed
    from keyed group by grouping sets ((audience_id), ())`);
  const per = grouped.filter((r) => n(r.is_total) === 0);
  const tot = grouped.find((r) => n(r.is_total) === 1);
  const byId = new Map(per.map((r) => [String(r.audience_id), r]));
  const audiencesOut = [...auds.values()]
    .map((a) => {
      const r = byId.get(a.id);
      return {
        ...audienceRef(a, a.id),
        orgId: a.orgId,
        offerId: a.offerId,
        targetText: a.targetText,
        ...counts(r),
      };
    })
    .sort((x, y) => y.people.held - x.people.held || String(x.name).localeCompare(String(y.name)));
  return {
    brandId: scope.brandId,
    acceptanceBar: SCREEN_MIN_YES_PROBABILITY,
    totals: counts(tot),
    audiences: audiencesOut,
  };
}

export interface PageArgs {
  limit: number;
  offset: number;
  acceptedOnly: boolean;
}

// 2. Brand-level people: each person once, with the lists that brought them in
// and the target audiences that accepted / rejected them.
export async function brandHeldPeople(scope: SnapshotScope, page: PageArgs) {
  const auds = await loadAudiences(scope);
  const having = page.acceptedOnly ? sql`having bool_or(accepted)` : sql``;
  const list = await rows<Record<string, unknown>>(sql`
    with ${heldSql(scope)},
    grouped as (
      select person_key, max(person_id) as person_id, max(name) as name, max(title) as title,
        max(company_key) as company_key, max(company_name) as company_name,
        max(company_domain) as company_domain, bool_or(revealed) as revealed,
        count(*) filter (where accepted) as accepted_count,
        jsonb_agg(jsonb_build_object(
          'audienceId', audience_id,
          'stage', case when revealed then 'revealed' when screened then 'screened' else 'buffered' end,
          'verdict', case when accepted then 'accepted' when screened then 'rejected' else null end,
          'yesProbability', yes_probability
        ) order by audience_id) as sources
      from keyed group by person_key ${having}
    )
    select *, count(*) over () as total from grouped
    order by accepted_count desc, revealed desc, name nulls last, person_key
    limit ${page.limit} offset ${page.offset}`);
  const total = list.length ? n(list[0].total) : await countPeople(scope, page.acceptedOnly);
  return {
    brandId: scope.brandId,
    acceptanceBar: SCREEN_MIN_YES_PROBABILITY,
    total,
    limit: page.limit,
    offset: page.offset,
    people: list.map((r) => {
      const sources = (r.sources as Array<{ audienceId: string; stage: string; verdict: string | null; yesProbability: number | null }>);
      return {
        personKey: String(r.person_key),
        personId: (r.person_id as string | null) ?? null,
        providerPersonId: String(r.person_key).startsWith("person:") ? null : String(r.person_key),
        name: (r.name as string | null) ?? null,
        title: (r.title as string | null) ?? null,
        company: r.company_key
          ? { companyKey: String(r.company_key), name: (r.company_name as string | null) ?? null, domain: (r.company_domain as string | null) ?? null }
          : null,
        revealed: r.revealed === true,
        sources: sources.map((s) => ({
          ...audienceRef(auds.get(s.audienceId), s.audienceId),
          stage: s.stage as "revealed" | "screened" | "buffered",
          verdict: s.verdict as "accepted" | "rejected" | null,
          yesProbability: s.yesProbability,
        })),
        acceptedBy: sources
          .filter((s) => s.verdict === "accepted")
          .map((s) => ({ ...audienceRef(auds.get(s.audienceId), s.audienceId), yesProbability: s.yesProbability })),
      };
    }),
  };
}

async function countPeople(scope: SnapshotScope, acceptedOnly: boolean) {
  const [r] = await rows<Record<string, unknown>>(sql`
    with ${heldSql(scope)}
    select count(distinct person_key) ${acceptedOnly ? sql`filter (where accepted)` : sql``} as total from keyed`);
  return n(r?.total);
}

// 3. Brand-level companies: each company once, how many people we hold there,
// from which lists, and which target audiences accepted at least one of them.
export async function brandHeldCompanies(scope: SnapshotScope, page: PageArgs) {
  const auds = await loadAudiences(scope);
  const having = page.acceptedOnly ? sql`having bool_or(accepted)` : sql``;
  const list = await rows<Record<string, unknown>>(sql`
    with ${heldSql(scope)},
    per_aud as (
      select company_key, audience_id,
        count(distinct person_key) as people,
        count(distinct person_key) filter (where accepted) as accepted
      from keyed where company_key is not null group by company_key, audience_id
    ),
    grouped as (
      select k.company_key, max(k.company_name) as company_name, max(k.company_domain) as company_domain,
        count(distinct k.person_key) as people,
        count(distinct k.person_key) filter (where k.revealed) as revealed,
        count(distinct k.person_key) filter (where k.accepted) as accepted,
        (select jsonb_agg(jsonb_build_object('audienceId', pa.audience_id, 'people', pa.people, 'accepted', pa.accepted)
                order by pa.audience_id)
         from per_aud pa where pa.company_key = k.company_key) as sources
      from keyed k where k.company_key is not null
      group by k.company_key ${having}
    )
    select *, count(*) over () as total from grouped
    order by accepted desc, people desc, company_name nulls last, company_key
    limit ${page.limit} offset ${page.offset}`);
  const total = list.length ? n(list[0].total) : await countCompanies(scope, page.acceptedOnly);
  return {
    brandId: scope.brandId,
    acceptanceBar: SCREEN_MIN_YES_PROBABILITY,
    total,
    limit: page.limit,
    offset: page.offset,
    companies: list.map((r) => {
      const sources = r.sources as Array<{ audienceId: string; people: number; accepted: number }>;
      return {
        companyKey: String(r.company_key),
        name: (r.company_name as string | null) ?? null,
        domain: (r.company_domain as string | null) ?? null,
        people: { held: n(r.people), revealed: n(r.revealed), accepted: n(r.accepted) },
        sources: sources.map((s) => ({
          ...audienceRef(auds.get(s.audienceId), s.audienceId),
          people: n(s.people),
          accepted: n(s.accepted),
        })),
        acceptedBy: sources
          .filter((s) => n(s.accepted) > 0)
          .map((s) => ({ ...audienceRef(auds.get(s.audienceId), s.audienceId), acceptedPeople: n(s.accepted) })),
      };
    }),
  };
}

async function countCompanies(scope: SnapshotScope, acceptedOnly: boolean) {
  const [r] = await rows<Record<string, unknown>>(sql`
    with ${heldSql(scope)}
    select count(distinct company_key) ${acceptedOnly ? sql`filter (where accepted)` : sql``} as total
    from keyed where company_key is not null`);
  return n(r?.total);
}
