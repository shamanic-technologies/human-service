import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences, audienceMembers, audienceTeaserScreenings, people } from "../../src/db/schema.js";
import {
  brandAudienceSnapshot,
  brandHeldCompanies,
  brandHeldPeople,
} from "../../src/services/audience-snapshot.js";
import { settleSnapshotRefreshes } from "../../src/services/audience-snapshot-cache.js";

// MON-PAGE-SPEED-FLOOR-1120: the snapshot reads answer from their stored last
// body (fast path) and refresh it behind the answer once it is a minute old.
// The fast path must return exactly what the computation returns.

const app = createTestApp();
const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000009";
const BRAND = "00000000-0000-4000-8000-0000000000d1";
const OTHER_BRAND = "00000000-0000-4000-8000-0000000000d2";
const PAGE = { limit: 100, offset: 0, acceptedOnly: false };
const PAGE_QS = "limit=100&offset=0&acceptedOnly=false";

beforeEach(async () => {
  process.env.AUDIENCE_SNAPSHOT_CACHE = "on";
  await cleanTestData();
});

afterEach(async () => {
  await settleSnapshotRefreshes();
  process.env.AUDIENCE_SNAPSHOT_CACHE = "off";
});

afterAll(async () => {
  await closeDb();
});

async function audience(name: string, brandId = BRAND, orgId = ORG) {
  const [row] = await db
    .insert(audiences)
    .values({ orgId, brandId, name, provider: "apollo", filters: { person_titles: ["Partner"] }, status: "active", targetText: `${name} target` })
    .returning();
  return row;
}

async function screen(audienceId: string, pid: string, company: string, yes: number, orgId = ORG) {
  await db.insert(audienceTeaserScreenings).values({
    orgId, audienceId, providerPersonId: pid,
    teaser: { name: `Name ${pid}`, title: "Partner", organizationName: company },
    verdict: yes > 0.5, yesProbability: yes, model: "typesafe/test", promptVersion: "v2",
  });
}

async function reveal(audienceId: string, pid: string, domain: string) {
  const [p] = await db
    .insert(people)
    .values({ orgId: ORG, apolloPersonId: pid, emailNorm: `${pid}@${domain}`, fullName: `Person ${pid}`, title: "Partner", companyDomain: domain })
    .returning();
  await db.insert(audienceMembers).values({ orgId: ORG, audienceId, personId: p.id, source: "apollo" });
}

async function seed() {
  const a = await audience("Partners");
  const b = await audience("Founders");
  await screen(a.id, "p1", "Smith Law", 0.9);
  await reveal(a.id, "p1", "smithlaw.com");
  await screen(a.id, "p2", "Smith Law", 0.2);
  await screen(b.id, "p3", "Jones LLP", 0.7);
  const other = await audience("Elsewhere", OTHER_BRAND);
  await screen(other.id, "p9", "Other Co", 0.95);
  return { a, b };
}

// Age every stored answer past the fresh window.
async function ageStored() {
  await db.execute(sql`update audience_snapshot_cache set computed_at = now() - interval '5 minutes'`);
}

const get = (path: string) => request(app).get(path).set(getAuthHeaders());

describe("audience snapshot stored answers", () => {
  it("answers each read with exactly the computed body (totals, people, companies)", async () => {
    await seed();
    const scope = { brandId: BRAND };
    const computed = {
      totals: JSON.parse(JSON.stringify(await brandAudienceSnapshot(scope))),
      people: JSON.parse(JSON.stringify(await brandHeldPeople(scope, PAGE))),
      companies: JSON.parse(JSON.stringify(await brandHeldCompanies(scope, PAGE))),
    };
    const paths = {
      totals: `/internal/brands/${BRAND}/audience-snapshot`,
      people: `/internal/brands/${BRAND}/audience-snapshot/people?${PAGE_QS}`,
      companies: `/internal/brands/${BRAND}/audience-snapshot/companies?${PAGE_QS}`,
    };
    for (const read of ["totals", "people", "companies"] as const) {
      const first = await get(paths[read]); // computes + stores
      const second = await get(paths[read]); // served from the stored copy
      expect(first.status).toBe(200);
      expect(first.body).toEqual(computed[read]);
      expect(second.text).toBe(first.text);
    }
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from audience_snapshot_cache`)) as unknown as Array<{ n: number }>;
    expect(n).toBe(3);
  });

  it("serves the stored answer while fresh, then refreshes it behind a stale read", async () => {
    const { b } = await seed();
    const path = `/internal/brands/${BRAND}/audience-snapshot`;
    const before = await get(path);
    expect(before.body.totals.people.held).toBe(3);

    await screen(b.id, "p4", "New Firm", 0.8);
    expect((await get(path)).body.totals.people.held).toBe(3); // fresh: stored answer

    await ageStored();
    expect((await get(path)).body.totals.people.held).toBe(3); // stale: stored answer, refresh started
    await settleSnapshotRefreshes();
    const after = await get(path);
    expect(after.body.totals.people.held).toBe(4);
    expect(after.body).toEqual(JSON.parse(JSON.stringify(await brandAudienceSnapshot({ brandId: BRAND }))));
  });

  it("never serves one brand's, org scope's or page's answer for another", async () => {
    await seed();
    await audience("Other org list", BRAND, OTHER_ORG);
    const all = await get(`/internal/brands/${BRAND}/audience-snapshot`);
    const one = await get(`/internal/brands/${BRAND}/audience-snapshot?orgId=${ORG}`);
    const other = await get(`/internal/brands/${OTHER_BRAND}/audience-snapshot`);
    expect(all.body.audiences).toHaveLength(3);
    expect(one.body.audiences).toHaveLength(2);
    expect(other.body.brandId).toBe(OTHER_BRAND);
    expect(other.body.totals.people.held).toBe(1);

    const p1 = await get(`/internal/brands/${BRAND}/audience-snapshot/people?limit=1&offset=0&acceptedOnly=false`);
    const p2 = await get(`/internal/brands/${BRAND}/audience-snapshot/people?limit=1&offset=1&acceptedOnly=false`);
    const acc = await get(`/internal/brands/${BRAND}/audience-snapshot/people?limit=1&offset=0&acceptedOnly=true`);
    expect(p1.body.people[0].personKey).not.toBe(p2.body.people[0].personKey);
    expect(acc.body.total).toBe(2);
    expect(p1.body.total).toBe(3);
  });

  it("keeps the stored answer when a refresh fails", async () => {
    await seed();
    const path = `/internal/brands/${BRAND}/audience-snapshot`;
    const before = await get(path);
    await ageStored();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let tags: unknown[] = [];
    await db.execute(sql`alter table audience_teaser_screenings rename to audience_teaser_screenings_off`);
    try {
      const during = await get(path);
      expect(during.text).toBe(before.text);
      await settleSnapshotRefreshes();
      tags = logged.mock.calls.map((c) => c[0]);
    } finally {
      await db.execute(sql`alter table audience_teaser_screenings_off rename to audience_teaser_screenings`);
      logged.mockRestore();
    }
    expect(tags).toContain("[audience_snapshot.refresh_failed]");
    expect((await get(path)).text).toBe(before.text);
  });
});
