import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences, audienceMembers, brandSuppressions, people, personEmails } from "../../src/db/schema.js";
import { computeAudienceContactability } from "../../src/services/audiences.js";

// MON-PAGE-SPEED-FLOOR-1120: the Size / Remaining suppressed-member count keeps
// each EXISTS a per-member index probe (`offset 0`). It must count exactly what
// the plain OR-of-EXISTS form counts: email, another address of the person,
// linkedin, another brand / org and out-of-window rows excluded.

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000009";
const BRAND = "00000000-0000-4000-8000-0000000000e1";
const OTHER_BRAND = "00000000-0000-4000-8000-0000000000e2";

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

async function person(email: string, linkedin: string | null = null) {
  const [p] = await db.insert(people).values({ orgId: ORG, emailNorm: email, linkedinUrlNorm: linkedin }).returning();
  await db.insert(personEmails).values({ orgId: ORG, personId: p.id, emailNorm: email, source: "served" });
  return p;
}

async function suppress(email: string, opts: { brandId?: string; orgId?: string; linkedin?: string; daysAgo?: number } = {}) {
  await db.insert(brandSuppressions).values({
    orgId: opts.orgId ?? ORG,
    brandId: opts.brandId ?? BRAND,
    emailNorm: email,
    linkedinUrlNorm: opts.linkedin ?? null,
    lastServedAt: new Date(Date.now() - (opts.daysAgo ?? 1) * 86_400_000),
  });
}

describe("audience contactability suppressed count", () => {
  it("counts exactly what the plain OR-of-EXISTS form counts", async () => {
    const [aud] = await db
      .insert(audiences)
      .values({ orgId: ORG, brandId: BRAND, name: "List", provider: "apollo", filters: { person_titles: ["CEO"] }, apolloCount: 100, status: "active" })
      .returning();
    const byEmail = await person("a@x.com");
    await suppress("a@x.com");
    const byOtherAddress = await person("b@x.com");
    await db.insert(personEmails).values({ orgId: ORG, personId: byOtherAddress.id, emailNorm: "b2@y.com", source: "attached" });
    await suppress("b2@y.com");
    const byLinkedin = await person("c@x.com", "linkedin.com/in/c");
    await suppress("zz@x.com", { linkedin: "linkedin.com/in/c" });
    const otherBrand = await person("d@x.com");
    await suppress("d@x.com", { brandId: OTHER_BRAND });
    const otherOrg = await person("e@x.com");
    await suppress("e@x.com", { orgId: OTHER_ORG });
    const lapsed = await person("f@x.com");
    await suppress("f@x.com", { daysAgo: 120 });
    const fresh = await person("g@x.com");
    for (const p of [byEmail, byOtherAddress, byLinkedin, otherBrand, otherOrg, lapsed, fresh]) {
      await db.insert(audienceMembers).values({ orgId: ORG, audienceId: aud.id, personId: p.id, source: "apollo" });
    }

    const [ref] = (await db.execute(sql`
      select count(distinct m.person_id)::int as n
      from audience_members m join audiences a on a.id = m.audience_id join people p on p.id = m.person_id
      where m.audience_id = ${aud.id} and (
        exists (select 1 from brand_suppressions s where s.org_id = a.org_id and s.brand_id = a.brand_id
                and s.email_norm = p.email_norm and s.last_served_at > now() - interval '3 months')
        or exists (select 1 from person_emails pe join brand_suppressions s on s.email_norm = pe.email_norm and s.org_id = pe.org_id
                   where pe.person_id = p.id and s.brand_id = a.brand_id and s.last_served_at > now() - interval '3 months')
        or (p.linkedin_url_norm is not null and exists (select 1 from brand_suppressions s where s.org_id = a.org_id
            and s.brand_id = a.brand_id and s.linkedin_url_norm = p.linkedin_url_norm and s.last_served_at > now() - interval '3 months')))
    `)) as unknown as Array<{ n: number }>;
    expect(ref.n).toBe(3);

    const out = await computeAudienceContactability([aud]);
    expect(out.get(aud.id)).toEqual({ sizeCount: 100, availableToContactCount: 100 - ref.n, availableToContactPct: 97 });
  });
});
