import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertHuman, insertMethodology } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  audiences,
  audienceMembers,
  audienceTeaserBuffer,
  audienceTeaserScreenings,
  audienceScreenedOut,
  brandSuppressions,
  humanMethodologies,
  humans,
  leadServes,
  listMembers,
  lists,
  people,
  suppressionBackfills,
  suppressionRecoveries,
} from "../../src/db/schema.js";

// Every table human-service holds brand history in, checked one by one: after a
// transfer nothing of the brand remains under the source org, the org's OTHER
// brand is untouched, and a second call is a no-op.

const app = createTestApp();
const headers = { "X-API-Key": "test-api-key", "Content-Type": "application/json" };

const SRC = "c0000000-0000-4000-8000-000000000001";
const TGT = "c0000000-0000-4000-8000-000000000002";
const BRAND = "d0000000-0000-4000-8000-00000000000a";
const OTHER_BRAND = "d0000000-0000-4000-8000-00000000000b";
const NEW_BRAND = "d0000000-0000-4000-8000-00000000000c";

const teaser = {
  name: "X", title: null, headline: null, seniority: null, city: null, state: null,
  country: null, organizationName: null, organizationIndustry: null,
  organizationEmployees: null, organizationCity: null, organizationState: null,
  organizationCountry: null, organizationKeywords: null,
};

async function seed() {
  const [aud] = await db.insert(audiences)
    .values({ orgId: SRC, brandId: BRAND, name: "Chiropractors", provider: "apollo" }).returning();
  const [otherAud] = await db.insert(audiences)
    .values({ orgId: SRC, brandId: OTHER_BRAND, name: "Dentists", provider: "apollo" }).returning();

  const [solo] = await db.insert(people)
    .values({ orgId: SRC, emailNorm: "solo@x.com", fullName: "Solo" }).returning();
  const [shared] = await db.insert(people)
    .values({ orgId: SRC, emailNorm: "shared@x.com", fullName: "Shared", apolloPersonId: "ap-shared" }).returning();
  const [otherOnly] = await db.insert(people)
    .values({ orgId: SRC, emailNorm: "other@x.com" }).returning();

  await db.insert(audienceMembers).values([
    { orgId: SRC, audienceId: aud.id, personId: solo.id, source: "apollo" },
    { orgId: SRC, audienceId: aud.id, personId: shared.id, source: "apollo" },
    { orgId: SRC, audienceId: otherAud.id, personId: shared.id, source: "apollo" },
    { orgId: SRC, audienceId: otherAud.id, personId: otherOnly.id, source: "apollo" },
  ]);
  await db.insert(audienceTeaserBuffer).values([
    { orgId: SRC, audienceId: aud.id, providerPersonId: "t1", teaser },
    { orgId: SRC, audienceId: otherAud.id, providerPersonId: "t2", teaser },
  ]);
  await db.insert(audienceTeaserScreenings).values([
    { orgId: SRC, audienceId: aud.id, providerPersonId: "t3", teaser, verdict: false, model: "m", promptVersion: "v1" },
    { orgId: SRC, audienceId: otherAud.id, providerPersonId: "t4", teaser, verdict: true, model: "m", promptVersion: "v1" },
  ]);
  await db.insert(audienceScreenedOut).values([
    { orgId: SRC, audienceId: aud.id, providerPersonId: "t3" },
    { orgId: SRC, audienceId: otherAud.id, providerPersonId: "t5" },
  ]);
  await db.insert(leadServes).values([
    { orgId: SRC, brandId: BRAND, provider: "apollo", email: "solo@x.com", audienceId: aud.id, campaignId: "camp-1" },
    { orgId: SRC, brandId: OTHER_BRAND, provider: "apollo", email: "other@x.com" },
  ]);
  const [supp] = await db.insert(brandSuppressions).values([
    { orgId: SRC, brandId: BRAND, emailNorm: "solo@x.com" },
    { orgId: SRC, brandId: OTHER_BRAND, emailNorm: "other@x.com" },
  ]).returning();
  const now = new Date();
  await db.insert(suppressionRecoveries).values([
    { reason: "r1", suppressionId: supp.id, orgId: SRC, brandId: BRAND, emailNorm: "gone@x.com", firstServedAt: now, lastServedAt: now },
    { reason: "r1", suppressionId: supp.id, orgId: SRC, brandId: OTHER_BRAND, emailNorm: "gone@x.com", firstServedAt: now, lastServedAt: now },
  ]);
  await db.insert(suppressionBackfills).values([
    { reason: "b1", suppressionId: supp.id, orgId: SRC, brandId: BRAND, emailNorm: "solo@x.com", sentAt: now },
    { reason: "b1", suppressionId: supp.id, orgId: SRC, brandId: OTHER_BRAND, emailNorm: "other@x.com", sentAt: now },
  ]);
  const [list] = await db.insert(lists).values({ orgId: SRC, brandId: BRAND, name: "VIPs" }).returning();
  const [otherList] = await db.insert(lists).values({ orgId: SRC, brandId: OTHER_BRAND, name: "Other" }).returning();
  const [orgList] = await db.insert(lists).values({ orgId: SRC, brandId: null, name: "Org-wide" }).returning();
  await db.insert(listMembers).values([
    { orgId: SRC, listId: list.id, sourceResourceId: "people/c1" },
    { orgId: SRC, listId: otherList.id, sourceResourceId: "people/c2" },
    { orgId: SRC, listId: orgList.id, sourceResourceId: "people/c3" },
  ]);
  const human = await insertHuman({ orgId: SRC, name: "Jane", slug: "jane", urls: ["https://j.example.com"] });
  const meth = await insertMethodology({ humanId: human.id });
  await db.update(humanMethodologies).set({ orgId: SRC, brandIds: [BRAND] }).where(eq(humanMethodologies.id, meth.id));

  return { aud, otherAud, solo, shared, otherOnly, list, orgList, human, meth };
}

async function transfer(targetBrandId?: string) {
  return request(app).post("/internal/transfer-brand").set(headers).send({
    sourceBrandId: BRAND, sourceOrgId: SRC, targetOrgId: TGT,
    ...(targetBrandId ? { targetBrandId } : {}),
  });
}

beforeEach(async () => { await cleanTestData(); });
afterAll(async () => { await cleanTestData(); await closeDb(); });

describe("POST /internal/transfer-brand — every table", () => {
  it("moves the whole brand, leaves the other brand, and a re-run is a no-op", async () => {
    const s = await seed();
    const res = await transfer(NEW_BRAND);
    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "human_methodologies", count: 1 },
      { tableName: "humans", count: 1 },
      { tableName: "audiences", count: 1 },
      { tableName: "audience_members", count: 2 },
      { tableName: "audience_teaser_buffer", count: 1 },
      { tableName: "audience_teaser_screenings", count: 1 },
      { tableName: "audience_screened_out", count: 1 },
      { tableName: "people", count: 2 },
      { tableName: "lead_serves", count: 1 },
      { tableName: "brand_suppressions", count: 1 },
      { tableName: "suppression_recoveries", count: 1 },
      { tableName: "suppression_backfills", count: 1 },
      { tableName: "lists", count: 1 },
      { tableName: "list_members", count: 1 },
    ]);

    // audiences
    const [aud] = await db.select().from(audiences).where(eq(audiences.id, s.aud.id));
    expect([aud.orgId, aud.brandId]).toEqual([TGT, NEW_BRAND]);
    const [otherAud] = await db.select().from(audiences).where(eq(audiences.id, s.otherAud.id));
    expect([otherAud.orgId, otherAud.brandId]).toEqual([SRC, OTHER_BRAND]);

    // audience children
    for (const t of [audienceTeaserBuffer, audienceTeaserScreenings, audienceScreenedOut]) {
      const rows = await db.select().from(t);
      for (const r of rows) {
        expect(r.orgId).toBe(r.audienceId === s.aud.id ? TGT : SRC);
      }
    }

    // people + members: solo person moved in place; shared person COPIED
    const [solo] = await db.select().from(people).where(eq(people.id, s.solo.id));
    expect(solo.orgId).toBe(TGT);
    const [sharedSrc] = await db.select().from(people).where(eq(people.id, s.shared.id));
    expect(sharedSrc.orgId).toBe(SRC);
    const [sharedCopy] = await db.select().from(people)
      .where(and(eq(people.orgId, TGT), eq(people.emailNorm, "shared@x.com")));
    expect(sharedCopy.id).not.toBe(s.shared.id);
    expect(sharedCopy.apolloPersonId).toBe("ap-shared");
    const members = await db.select().from(audienceMembers);
    const transferred = members.filter((m) => m.audienceId === s.aud.id);
    expect(transferred.map((m) => m.orgId)).toEqual([TGT, TGT]);
    expect(new Set(transferred.map((m) => m.personId))).toEqual(new Set([s.solo.id, sharedCopy.id]));
    const kept = members.filter((m) => m.audienceId === s.otherAud.id);
    expect(kept.every((m) => m.orgId === SRC)).toBe(true);
    expect(new Set(kept.map((m) => m.personId))).toEqual(new Set([s.shared.id, s.otherOnly.id]));
    // every membership points at a person of its own org
    const byId = new Map((await db.select().from(people)).map((p) => [p.id, p.orgId]));
    for (const m of members) expect(byId.get(m.personId)).toBe(m.orgId);

    // brand-keyed tables
    for (const t of [leadServes, brandSuppressions, suppressionRecoveries, suppressionBackfills]) {
      const rows = await db.select().from(t);
      expect(rows.filter((r) => r.orgId === SRC && r.brandId === BRAND)).toEqual([]);
      expect(rows.filter((r) => r.orgId === TGT).map((r) => r.brandId)).toEqual([NEW_BRAND]);
      expect(rows.filter((r) => r.orgId === SRC).map((r) => r.brandId)).toEqual([OTHER_BRAND]);
    }
    const [serve] = await db.select().from(leadServes).where(eq(leadServes.orgId, TGT));
    expect(serve.campaignId).toBe("camp-1");

    // lists: brand list moves, other-brand and org-wide lists stay
    const allLists = await db.select().from(lists);
    expect(allLists.find((l) => l.id === s.list.id)).toMatchObject({ orgId: TGT, brandId: NEW_BRAND });
    expect(allLists.filter((l) => l.orgId === SRC)).toHaveLength(2);
    const lm = await db.select().from(listMembers);
    expect(lm.find((m) => m.listId === s.list.id)!.orgId).toBe(TGT);
    expect(lm.filter((m) => m.orgId === SRC)).toHaveLength(2);

    // legacy methodology + its expert profile
    const [meth] = await db.select().from(humanMethodologies).where(eq(humanMethodologies.id, s.meth.id));
    expect([meth.orgId, meth.brandIds]).toEqual([TGT, [NEW_BRAND]]);
    const [human] = await db.select().from(humans).where(eq(humans.id, s.human.id));
    expect(human.orgId).toBe(TGT);

    // re-run: nothing left to move
    const again = await transfer(NEW_BRAND);
    expect(again.status).toBe(200);
    expect(again.body.updatedTables).toEqual([]);
  });

  it("completes the brand rewrite when first run without targetBrandId", async () => {
    const s = await seed();
    await transfer();
    const [aud1] = await db.select().from(audiences).where(eq(audiences.id, s.aud.id));
    expect([aud1.orgId, aud1.brandId]).toEqual([TGT, BRAND]);

    const res = await transfer(NEW_BRAND);
    expect(res.status).toBe(200);
    const [aud2] = await db.select().from(audiences).where(eq(audiences.id, s.aud.id));
    expect(aud2.brandId).toBe(NEW_BRAND);
    const serves = await db.select().from(leadServes).where(eq(leadServes.orgId, TGT));
    expect(serves.map((r) => r.brandId)).toEqual([NEW_BRAND]);
    expect((await transfer(NEW_BRAND)).body.updatedTables).toEqual([]);
  });

  it("merges into rows the target org already holds instead of colliding", async () => {
    const s = await seed();
    const older = new Date("2026-01-01T00:00:00Z");
    // target already knows solo@x.com as a person and as a suppression
    const [tgtPerson] = await db.insert(people).values({ orgId: TGT, emailNorm: "solo@x.com" }).returning();
    await db.insert(brandSuppressions).values({
      orgId: TGT, brandId: NEW_BRAND, emailNorm: "solo@x.com", firstServedAt: older, lastServedAt: older,
    });

    const res = await transfer(NEW_BRAND);
    expect(res.status).toBe(200);

    // source person collapsed onto the target's same-email person
    expect(await db.select().from(people).where(eq(people.id, s.solo.id))).toEqual([]);
    const m = await db.select().from(audienceMembers).where(eq(audienceMembers.audienceId, s.aud.id));
    expect(m.map((r) => r.personId)).toContain(tgtPerson.id);

    // one suppression row for the person, carrying the newer serve
    const supp = await db.select().from(brandSuppressions)
      .where(and(eq(brandSuppressions.orgId, TGT), eq(brandSuppressions.emailNorm, "solo@x.com")));
    expect(supp).toHaveLength(1);
    expect(supp[0].firstServedAt.getTime()).toBe(older.getTime());
    expect(supp[0].lastServedAt.getTime()).toBeGreaterThan(older.getTime());
    expect(await db.select().from(brandSuppressions)
      .where(and(eq(brandSuppressions.orgId, SRC), eq(brandSuppressions.brandId, BRAND)))).toEqual([]);
  });

  it("fails loud and moves nothing on an audience name collision", async () => {
    const s = await seed();
    await db.insert(audiences).values({ orgId: TGT, brandId: NEW_BRAND, name: "chiropractors" });
    const res = await transfer(NEW_BRAND);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/nothing was moved/);
    const [aud] = await db.select().from(audiences).where(eq(audiences.id, s.aud.id));
    expect(aud.orgId).toBe(SRC);
    const serves = await db.select().from(leadServes).where(eq(leadServes.brandId, BRAND));
    expect(serves.map((r) => r.orgId)).toEqual([SRC]);
  });

  it("does not touch the same brand held by another org", async () => {
    const OTHER_ORG = "c0000000-0000-4000-8000-000000000099";
    await seed();
    const [foreign] = await db.insert(audiences)
      .values({ orgId: OTHER_ORG, brandId: BRAND, name: "Foreign" }).returning();
    await transfer(NEW_BRAND);
    const [row] = await db.select().from(audiences).where(eq(audiences.id, foreign.id));
    expect([row.orgId, row.brandId]).toEqual([OTHER_ORG, BRAND]);
  });
});
