import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertHuman,
  insertMethodology,
} from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { humanMethodologies } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const app = createTestApp();
const apiKeyHeader = { "X-API-Key": "test-api-key", "Content-Type": "application/json" };

const SOURCE_ORG = "a0000000-0000-4000-8000-000000000001";
const TARGET_ORG = "a0000000-0000-4000-8000-000000000002";
const BRAND_A = "b0000000-0000-4000-8000-00000000000a";
const BRAND_B = "b0000000-0000-4000-8000-00000000000b";

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /internal/transfer-brand", () => {
  it("transfers solo-brand methodology rows to target org", async () => {
    const human = await insertHuman({
      orgId: SOURCE_ORG,
      name: "Jane",
      slug: "jane",
      urls: ["https://jane.example.com"],
    });

    const meth = await insertMethodology({ humanId: human.id });

    // Set org_id and brand_ids directly
    await db
      .update(humanMethodologies)
      .set({ orgId: SOURCE_ORG, brandIds: [BRAND_A] })
      .where(eq(humanMethodologies.id, meth.id));

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(apiKeyHeader)
      .send({ sourceBrandId: BRAND_A, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "human_methodologies", count: 1 },
    ]);

    // Verify org_id was updated
    const [updated] = await db
      .select()
      .from(humanMethodologies)
      .where(eq(humanMethodologies.id, meth.id));
    expect(updated.orgId).toBe(TARGET_ORG);
  });

  it("skips co-brand methodology rows (multiple brand_ids)", async () => {
    const human = await insertHuman({
      orgId: SOURCE_ORG,
      name: "John",
      slug: "john",
      urls: ["https://john.example.com"],
    });

    const meth = await insertMethodology({ humanId: human.id });

    await db
      .update(humanMethodologies)
      .set({ orgId: SOURCE_ORG, brandIds: [BRAND_A, BRAND_B] })
      .where(eq(humanMethodologies.id, meth.id));

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(apiKeyHeader)
      .send({ sourceBrandId: BRAND_A, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([]);

    // Verify org_id was NOT changed
    const [unchanged] = await db
      .select()
      .from(humanMethodologies)
      .where(eq(humanMethodologies.id, meth.id));
    expect(unchanged.orgId).toBe(SOURCE_ORG);
  });

  it("is idempotent — second call is a no-op", async () => {
    const human = await insertHuman({
      orgId: SOURCE_ORG,
      name: "Jane",
      slug: "jane",
      urls: ["https://jane.example.com"],
    });

    const meth = await insertMethodology({ humanId: human.id });

    await db
      .update(humanMethodologies)
      .set({ orgId: SOURCE_ORG, brandIds: [BRAND_A] })
      .where(eq(humanMethodologies.id, meth.id));

    // First call
    await request(app)
      .post("/internal/transfer-brand")
      .set(apiKeyHeader)
      .send({ sourceBrandId: BRAND_A, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG });

    // Second call — should be no-op
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(apiKeyHeader)
      .send({ sourceBrandId: BRAND_A, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([]);
  });

  it("does not affect rows from a different org", async () => {
    const human = await insertHuman({
      orgId: "a0000000-0000-4000-8000-000000000099",
      name: "Other",
      slug: "other",
      urls: ["https://other.example.com"],
    });

    const meth = await insertMethodology({ humanId: human.id });

    await db
      .update(humanMethodologies)
      .set({ orgId: "a0000000-0000-4000-8000-000000000099", brandIds: [BRAND_A] })
      .where(eq(humanMethodologies.id, meth.id));

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(apiKeyHeader)
      .send({ sourceBrandId: BRAND_A, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([]);

    // Verify org_id unchanged
    const [unchanged] = await db
      .select()
      .from(humanMethodologies)
      .where(eq(humanMethodologies.id, meth.id));
    expect(unchanged.orgId).toBe("a0000000-0000-4000-8000-000000000099");
  });

  it("skips rows with null brand_ids", async () => {
    const human = await insertHuman({
      orgId: SOURCE_ORG,
      name: "NoBrand",
      slug: "nobrand",
      urls: ["https://nobrand.example.com"],
    });

    const meth = await insertMethodology({ humanId: human.id });

    await db
      .update(humanMethodologies)
      .set({ orgId: SOURCE_ORG, brandIds: null })
      .where(eq(humanMethodologies.id, meth.id));

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(apiKeyHeader)
      .send({ sourceBrandId: BRAND_A, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([]);
  });

  it("returns 400 for missing fields", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(apiKeyHeader)
      .send({ sourceBrandId: BRAND_A });

    expect(res.status).toBe(400);
  });

  it("rewrites brand_ids when targetBrandId is provided (conflict)", async () => {
    const TARGET_BRAND = "b0000000-0000-4000-8000-00000000000c";
    const human = await insertHuman({
      orgId: SOURCE_ORG,
      name: "Conflict",
      slug: "conflict",
      urls: ["https://conflict.example.com"],
    });

    const meth = await insertMethodology({ humanId: human.id });

    await db
      .update(humanMethodologies)
      .set({ orgId: SOURCE_ORG, brandIds: [BRAND_A] })
      .where(eq(humanMethodologies.id, meth.id));

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(apiKeyHeader)
      .send({
        sourceBrandId: BRAND_A,
        sourceOrgId: SOURCE_ORG,
        targetOrgId: TARGET_ORG,
        targetBrandId: TARGET_BRAND,
      });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "human_methodologies", count: 1 },
    ]);

    const [updated] = await db
      .select()
      .from(humanMethodologies)
      .where(eq(humanMethodologies.id, meth.id));
    expect(updated.orgId).toBe(TARGET_ORG);
    expect(updated.brandIds).toEqual([TARGET_BRAND]);
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ sourceBrandId: BRAND_A, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG });

    expect(res.status).toBe(401);
  });

  it("does not require identity headers (internal endpoint)", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(apiKeyHeader)
      .send({ sourceBrandId: BRAND_A, sourceOrgId: SOURCE_ORG, targetOrgId: TARGET_ORG });

    // Should succeed without x-org-id, x-user-id, x-run-id
    expect(res.status).toBe(200);
  });
});
