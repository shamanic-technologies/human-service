import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { tagAudienceServe } from "../../src/services/audiences.js";
import type { ServedContact } from "../../src/services/suppression.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";

const app = createTestApp();

const ORG_A = "00000000-0000-0000-0000-000000000001";
const ORG_B = "00000000-0000-0000-0000-0000000000bb";
const BRAND_1 = "00000000-0000-4000-8000-0000000000a1";
const BRAND_2 = "00000000-0000-4000-8000-0000000000a2";
// strict-v4 audience ids (4th group starts 8/9/a/b, version nibble 4)
const A_ACTIVE = "00000000-0000-4000-8000-0000000000e1";
const A_ACTIVE_2 = "00000000-0000-4000-8000-0000000000e2";
const A_ARCHIVED = "00000000-0000-4000-8000-0000000000e3";
const A_SUGGESTED = "00000000-0000-4000-8000-0000000000e4";
const A_BRAND2 = "00000000-0000-4000-8000-0000000000e5";
const CANON = "00000000-0000-4000-8000-0000000000c1";
const DEPR = "00000000-0000-4000-8000-0000000000d1";
const DEPR_ORPHAN = "00000000-0000-4000-8000-0000000000d2";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";

function contact(p: Partial<ServedContact>): ServedContact {
  return {
    email: null,
    linkedinUrl: null,
    firstName: null,
    lastName: null,
    companyDomain: null,
    provider: "apollo",
    providerPersonId: null,
    ...p,
  };
}

function resolve(body: Record<string, unknown>) {
  return request(app)
    .post("/internal/audiences/resolve")
    .set({ "X-API-Key": "test-api-key", "Content-Type": "application/json" })
    .send(body);
}

async function insertAudience(row: Record<string, unknown>) {
  await db.insert(audiences).values(row as never);
}

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

describe("POST /internal/audiences/resolve — auth + validation", () => {
  it("401 without a valid api key", async () => {
    const res = await request(app)
      .post("/internal/audiences/resolve")
      .set({ "Content-Type": "application/json" })
      .send({ orgId: ORG_A, brandId: BRAND_1, emails: ["x@y.com"] });
    expect(res.status).toBe(401);
  });

  it("400 when neither audienceIds nor emails provided", async () => {
    const res = await resolve({ orgId: ORG_A, brandId: BRAND_1 });
    expect(res.status).toBe(400);
  });

  it("400 when brandId is not a uuid", async () => {
    const res = await resolve({
      orgId: ORG_A,
      brandId: "not-a-uuid",
      emails: ["x@y.com"],
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /internal/audiences/resolve — by email", () => {
  it("resolves an active audience to {id,name,avatarUrl}", async () => {
    await insertAudience({
      id: A_ACTIVE,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "Founders",
      status: "active",
      avatarUrl: "data:image/png;base64,AAA",
    });
    await tagAudienceServe(ORG_A, A_ACTIVE, [
      contact({ email: "Ann@X.com", firstName: "Ann" }),
    ]);

    const res = await resolve({
      orgId: ORG_A,
      brandId: BRAND_1,
      emails: ["Ann@X.com", "ghost@x.com"],
    });
    expect(res.status).toBe(200);
    // keyed by the RAW email as sent (normalization is internal)
    expect(res.body.byEmail["Ann@X.com"]).toEqual({
      id: A_ACTIVE,
      name: "Founders",
      avatarUrl: "data:image/png;base64,AAA",
    });
    expect(res.body.byEmail["ghost@x.com"]).toBeNull();
  });

  it("brand-correct: a person in two brands resolves only the requested brand", async () => {
    await insertAudience({
      id: A_ACTIVE,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "Brand1 Aud",
      status: "active",
    });
    await insertAudience({
      id: A_BRAND2,
      orgId: ORG_A,
      brandId: BRAND_2,
      name: "Brand2 Aud",
      status: "active",
    });
    const c = contact({ email: "dual@x.com" });
    await tagAudienceServe(ORG_A, A_ACTIVE, [c]);
    await tagAudienceServe(ORG_A, A_BRAND2, [c]);

    const r1 = await resolve({
      orgId: ORG_A,
      brandId: BRAND_1,
      emails: ["dual@x.com"],
    });
    expect(r1.body.byEmail["dual@x.com"]).toMatchObject({ name: "Brand1 Aud" });

    const r2 = await resolve({
      orgId: ORG_A,
      brandId: BRAND_2,
      emails: ["dual@x.com"],
    });
    expect(r2.body.byEmail["dual@x.com"]).toMatchObject({ name: "Brand2 Aud" });
  });

  it("active-preferred: active wins over archived for the same person", async () => {
    await insertAudience({
      id: A_ARCHIVED,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "Old Archived",
      status: "archived",
    });
    await insertAudience({
      id: A_ACTIVE,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "Live One",
      status: "active",
    });
    const c = contact({ email: "pref@x.com" });
    await tagAudienceServe(ORG_A, A_ARCHIVED, [c]);
    await tagAudienceServe(ORG_A, A_ACTIVE, [c]);

    const res = await resolve({
      orgId: ORG_A,
      brandId: BRAND_1,
      emails: ["pref@x.com"],
    });
    expect(res.body.byEmail["pref@x.com"]).toMatchObject({ name: "Live One" });
  });

  it("archived-only still resolves (coverage), but suggested-only does not", async () => {
    await insertAudience({
      id: A_ARCHIVED,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "Archived Aud",
      status: "archived",
    });
    await insertAudience({
      id: A_SUGGESTED,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "Suggested Aud",
      status: "suggested",
    });
    await tagAudienceServe(ORG_A, A_ARCHIVED, [
      contact({ email: "arch@x.com" }),
    ]);
    await tagAudienceServe(ORG_A, A_SUGGESTED, [
      contact({ email: "sugg@x.com" }),
    ]);

    const res = await resolve({
      orgId: ORG_A,
      brandId: BRAND_1,
      emails: ["arch@x.com", "sugg@x.com"],
    });
    expect(res.body.byEmail["arch@x.com"]).toMatchObject({
      name: "Archived Aud",
    });
    expect(res.body.byEmail["sugg@x.com"]).toBeNull();
  });

  it("deprecated -> canonical: resolves to the live twin, orphan deprecated -> null", async () => {
    await insertAudience({
      id: CANON,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "Agency Owners",
      status: "active",
      avatarUrl: "data:image/png;base64,CANON",
    });
    await insertAudience({
      id: DEPR,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "Agency Owners [Apify]",
      status: "deprecated",
      canonicalAudienceId: CANON,
    });
    await insertAudience({
      id: DEPR_ORPHAN,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "Lonely [Apify]",
      status: "deprecated",
      canonicalAudienceId: null,
    });
    await tagAudienceServe(ORG_A, DEPR, [contact({ email: "mike@x.com" })]);
    await tagAudienceServe(ORG_A, DEPR_ORPHAN, [
      contact({ email: "lone@x.com" }),
    ]);

    const res = await resolve({
      orgId: ORG_A,
      brandId: BRAND_1,
      emails: ["mike@x.com", "lone@x.com"],
    });
    // deprecated variant resolves to the canonical active card (name + avatar)
    expect(res.body.byEmail["mike@x.com"]).toEqual({
      id: CANON,
      name: "Agency Owners",
      avatarUrl: "data:image/png;base64,CANON",
    });
    // orphan deprecated (no live twin) is not surfaced
    expect(res.body.byEmail["lone@x.com"]).toBeNull();
  });

  it("org-scoped: org B cannot resolve org A's email", async () => {
    await insertAudience({
      id: A_ACTIVE,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "A Aud",
      status: "active",
    });
    await tagAudienceServe(ORG_A, A_ACTIVE, [
      contact({ email: "a-only@x.com" }),
    ]);
    const res = await resolve({
      orgId: ORG_B,
      brandId: BRAND_1,
      emails: ["a-only@x.com"],
    });
    expect(res.body.byEmail["a-only@x.com"]).toBeNull();
  });
});

describe("POST /internal/audiences/resolve — by audienceId", () => {
  it("resolves a brand-correct audience, nulls a foreign-brand and unknown id", async () => {
    await insertAudience({
      id: A_ACTIVE,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "In Brand",
      status: "active",
      avatarUrl: "data:image/png;base64,AV",
    });
    await insertAudience({
      id: A_BRAND2,
      orgId: ORG_A,
      brandId: BRAND_2,
      name: "Other Brand",
      status: "active",
    });

    const res = await resolve({
      orgId: ORG_A,
      brandId: BRAND_1,
      audienceIds: [A_ACTIVE, A_BRAND2, UNKNOWN],
    });
    expect(res.body.byAudienceId[A_ACTIVE]).toEqual({
      id: A_ACTIVE,
      name: "In Brand",
      avatarUrl: "data:image/png;base64,AV",
    });
    expect(res.body.byAudienceId[A_BRAND2]).toBeNull(); // foreign brand
    expect(res.body.byAudienceId[UNKNOWN]).toBeNull();
  });

  it("a deprecated audienceId resolves to its canonical twin", async () => {
    await insertAudience({
      id: CANON,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "Canon Live",
      status: "active",
    });
    await insertAudience({
      id: DEPR,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "Canon Live [Apify]",
      status: "deprecated",
      canonicalAudienceId: CANON,
    });
    const res = await resolve({
      orgId: ORG_A,
      brandId: BRAND_1,
      audienceIds: [DEPR],
    });
    expect(res.body.byAudienceId[DEPR]).toMatchObject({
      id: CANON,
      name: "Canon Live",
    });
  });
});

describe("POST /internal/audiences/resolve — no browser body cap", () => {
  it("accepts a payload far larger than 100 KB (thousands of emails)", async () => {
    await insertAudience({
      id: A_ACTIVE,
      orgId: ORG_A,
      brandId: BRAND_1,
      name: "Big",
      status: "active",
    });
    await tagAudienceServe(ORG_A, A_ACTIVE, [
      contact({ email: "needle@x.com" }),
    ]);
    // ~8000 emails * ~22 bytes ≈ 176 KB > the 100 KB global cap.
    const emails = Array.from(
      { length: 8000 },
      (_, i) => `filler${i}@example.com`
    );
    emails.push("needle@x.com");

    const res = await resolve({ orgId: ORG_A, brandId: BRAND_1, emails });
    expect(res.status).toBe(200);
    expect(res.body.byEmail["needle@x.com"]).toMatchObject({ name: "Big" });
    expect(res.body.byEmail["filler0@example.com"]).toBeNull();
  });
});
