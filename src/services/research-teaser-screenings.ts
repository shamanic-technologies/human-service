// Fleet-wide research read: how the pre-pay Jev screen decided, per month, while
// human-service ran it (prompt v2, 2026-09-28 -> 2026-10-07; lead-service since).
// Only Jev-judged rows count (yes_probability set); v1 glm-flash rows carry no
// probability and are left out. Pure DB read, one grouped scan of a table that
// no longer grows. Staff only (api key), ids never leave as names.
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export const SCREENING_BUCKETS = ["below_0_2", "0_2_to_0_5", "0_5_to_0_8", "0_8_and_above"] as const;
export type ScreeningBucket = (typeof SCREENING_BUCKETS)[number];

interface Counts { screened: number; passed: number; declined: number }

export interface TeaserScreeningResearch {
  screen: "human-service";
  firstScreenedAt: string | null;
  lastScreenedAt: string | null;
  totals: Counts & { distinctOrgs: number; distinctAudiences: number };
  months: Array<Counts & { month: string; buckets: Record<ScreeningBucket, Counts> }>;
}

const empty = (): Counts => ({ screened: 0, passed: 0, declined: 0 });

function add(target: Counts, passed: number, declined: number) {
  target.passed += passed;
  target.declined += declined;
  target.screened += passed + declined;
}

export async function teaserScreeningResearch(): Promise<TeaserScreeningResearch> {
  // Bucket edges mirror the pass rule: a pass needs P(yes) > 0.5, so 0.5 itself
  // sits in the 0.2-0.5 bucket.
  const groups = (await db.execute(sql`
    select to_char(date_trunc('month', created_at at time zone 'UTC'), 'YYYY-MM') as month,
           case when yes_probability < 0.2 then 'below_0_2'
                when yes_probability <= 0.5 then '0_2_to_0_5'
                when yes_probability < 0.8 then '0_5_to_0_8'
                else '0_8_and_above' end as bucket,
           count(*) filter (where verdict)::int as passed,
           count(*) filter (where not verdict)::int as declined
    from audience_teaser_screenings
    where yes_probability is not null
    group by 1, 2
    order by 1, 2`)) as unknown as Array<{ month: string; bucket: ScreeningBucket; passed: number; declined: number }>;

  const [reach] = (await db.execute(sql`
    select count(distinct org_id)::int as orgs, count(distinct audience_id)::int as audiences,
           min(created_at) as first_at, max(created_at) as last_at
    from audience_teaser_screenings
    where yes_probability is not null`)) as unknown as Array<{
    orgs: number; audiences: number; first_at: Date | string | null; last_at: Date | string | null;
  }>;

  const totals = { ...empty(), distinctOrgs: reach.orgs, distinctAudiences: reach.audiences };
  const byMonth = new Map<string, TeaserScreeningResearch["months"][number]>();
  for (const g of groups) {
    let m = byMonth.get(g.month);
    if (!m) {
      m = { month: g.month, ...empty(), buckets: Object.fromEntries(SCREENING_BUCKETS.map((b) => [b, empty()])) as Record<ScreeningBucket, Counts> };
      byMonth.set(g.month, m);
    }
    add(m, g.passed, g.declined);
    add(m.buckets[g.bucket], g.passed, g.declined);
    add(totals, g.passed, g.declined);
  }
  const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
  return {
    screen: "human-service",
    firstScreenedAt: iso(reach.first_at),
    lastScreenedAt: iso(reach.last_at),
    totals,
    months: [...byMonth.values()],
  };
}
