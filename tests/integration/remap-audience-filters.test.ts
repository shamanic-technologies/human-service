import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const app = createTestApp();
const apiKeyHeader = {
  "X-API-Key": "test-api-key",
  "Content-Type": "application/json",
};

const ORG = "a0000000-0000-4000-8000-000000000001";
const BRAND = "b0000000-0000-4000-8000-00000000000a";
const BACKFILL_LEGACY = "c0000000-0000-4000-8000-000000000001";
const BACKFILL_CANONICAL = "c0000000-0000-4000-8000-000000000002";
const NATIVE = "c0000000-0000-4000-8000-000000000003";

async function seed() {
  await db.insert(audiences).values([
    {
      id: BACKFILL_LEGACY,
      orgId: ORG,
      brandId: BRAND,
      name: "Legacy persona",
      filters: {
        industry: ["SaaS"],
        jobTitles: ["CEO"],
        seniority: ["Manager", "Intern"],
        department: ["human resources"],
        location: ["France"],
        employeeRange: ["11-50", "51-200"],
        keywords: ["growth"],
      },
      status: "active",
      source: "brand_persona_backfill",
    },
    {
      id: BACKFILL_CANONICAL,
      orgId: ORG,
      brandId: BRAND,
      name: "Already canonical backfill",
      filters: { titles: ["CTO"], keywords: ["devtools"] },
      status: "active",
      source: "brand_persona_backfill",
    },
    {
      id: NATIVE,
      orgId: ORG,
      brandId: BRAND,
      name: "Native audience",
      filters: { titles: ["VP Sales"] },
      status: "active",
      source: null,
    },
  ]);
}

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /internal/remap-audience-filters", () => {
  it("dry-run reports counts + before/after sample without writing", async () => {
    await seed();
    const res = await request(app)
      .post("/internal/remap-audience-filters?dryRun=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.scanned).toBe(2); // two backfill rows (native excluded)
    expect(res.body.wouldRemap).toBe(1); // only the legacy one
    expect(res.body.remapped).toBe(0);
    expect(res.body.alreadyCanonical).toBe(1);
    expect(res.body.sample).toHaveLength(1);
    expect(res.body.sample[0].id).toBe(BACKFILL_LEGACY);
    expect(res.body.sample[0].after).toEqual({
      industries: ["SaaS"],
      titles: ["CEO"],
      seniorities: ["manager"],
      functions: ["human_resources"],
      locationCountries: ["France"],
      employeeMin: 11,
      employeeMax: 200,
      keywords: ["growth"],
    });

    // Nothing written.
    const [row] = await db
      .select({ filters: audiences.filters })
      .from(audiences)
      .where(eq(audiences.id, BACKFILL_LEGACY));
    expect(row.filters).toHaveProperty("industry");
  });

  it("real run translates legacy rows, leaves native + canonical untouched, then re-run is a no-op", async () => {
    await seed();
    const res = await request(app)
      .post("/internal/remap-audience-filters?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.remapped).toBe(1);
    expect(res.body.alreadyCanonical).toBe(1);

    const [legacy] = await db
      .select({ filters: audiences.filters })
      .from(audiences)
      .where(eq(audiences.id, BACKFILL_LEGACY));
    expect(legacy.filters).toEqual({
      industries: ["SaaS"],
      titles: ["CEO"],
      seniorities: ["manager"],
      functions: ["human_resources"],
      locationCountries: ["France"],
      employeeMin: 11,
      employeeMax: 200,
      keywords: ["growth"],
    });

    // Native audience untouched (not source=brand_persona_backfill).
    const [native] = await db
      .select({ filters: audiences.filters })
      .from(audiences)
      .where(eq(audiences.id, NATIVE));
    expect(native.filters).toEqual({ titles: ["VP Sales"] });

    // Re-run: nothing left to remap.
    const reRun = await request(app)
      .post("/internal/remap-audience-filters?dryRun=false")
      .set(apiKeyHeader);
    expect(reRun.body.remapped).toBe(0);
    expect(reRun.body.alreadyCanonical).toBe(2);
  });

  it("fails loud (502) on an unrepresentable persona key", async () => {
    await db.insert(audiences).values({
      id: BACKFILL_LEGACY,
      orgId: ORG,
      brandId: BRAND,
      name: "Broken",
      // jobTitles makes the row persona-vocab (so the mapper runs); mysteryKey
      // has no canonical target -> mapper throws -> 502.
      filters: { jobTitles: ["CEO"], mysteryKey: ["x"] },
      status: "active",
      source: "brand_persona_backfill",
    });
    const res = await request(app)
      .post("/internal/remap-audience-filters?dryRun=true")
      .set(apiKeyHeader);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/mysteryKey/);
  });

  it("requires api key", async () => {
    const res = await request(app).post("/internal/remap-audience-filters");
    expect(res.status).toBe(401);
  });
});
