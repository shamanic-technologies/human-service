import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

const { mockFetchAllPersonas } = vi.hoisted(() => ({
  mockFetchAllPersonas: vi.fn(),
}));

// Passthrough mock: keep the real error classes (the route does `instanceof`
// checks) and only override the network call.
vi.mock("../../src/lib/brand-client.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  fetchAllPersonas: mockFetchAllPersonas,
}));

import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { BrandServiceError } from "../../src/lib/brand-client.js";

const app = createTestApp();
const apiKeyHeader = { "X-API-Key": "test-api-key", "Content-Type": "application/json" };

const ORG_1 = "a0000000-0000-4000-8000-000000000001";
const ORG_2 = "a0000000-0000-4000-8000-000000000002";
const BRAND_A = "b0000000-0000-4000-8000-00000000000a";
const PERSONA_1 = "c0000000-0000-4000-8000-000000000001";
const PERSONA_2 = "c0000000-0000-4000-8000-000000000002";

const PERSONAS = [
  {
    id: PERSONA_1,
    orgId: ORG_1,
    brandId: BRAND_A,
    name: "Founders",
    filters: { titles: ["CEO", "Founder"] },
    status: "active" as const,
  },
  {
    id: PERSONA_2,
    orgId: ORG_2,
    brandId: BRAND_A,
    name: "Marketers",
    filters: { titles: ["CMO"] },
    status: "paused" as const,
  },
];

beforeEach(async () => {
  await cleanTestData();
  mockFetchAllPersonas.mockReset();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /internal/backfill-audiences-from-personas", () => {
  it("dry-run reports counts and writes nothing", async () => {
    mockFetchAllPersonas.mockResolvedValue(PERSONAS);

    const res = await request(app)
      .post("/internal/backfill-audiences-from-personas?dryRun=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      dryRun: true,
      totalPersonas: 2,
      inserted: 0,
      skipped: 0,
    });

    const rows = await db.select().from(audiences);
    expect(rows.length).toBe(0);
  });

  it("real run copies personas to audiences, preserving id + provenance + status", async () => {
    mockFetchAllPersonas.mockResolvedValue(PERSONAS);

    const res = await request(app)
      .post("/internal/backfill-audiences-from-personas")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      dryRun: false,
      totalPersonas: 2,
      inserted: 2,
      skipped: 0,
    });

    const [aud1] = await db
      .select()
      .from(audiences)
      .where(eq(audiences.id, PERSONA_1));
    // id preserved (audience id == source persona id)
    expect(aud1.id).toBe(PERSONA_1);
    expect(aud1.orgId).toBe(ORG_1);
    expect(aud1.brandId).toBe(BRAND_A);
    expect(aud1.name).toBe("Founders");
    expect(aud1.status).toBe("active");
    expect(aud1.source).toBe("brand_persona_backfill");
    expect(aud1.filters).toEqual({ titles: ["CEO", "Founder"] });

    const [aud2] = await db
      .select()
      .from(audiences)
      .where(eq(audiences.id, PERSONA_2));
    expect(aud2.status).toBe("paused");
    expect(aud2.orgId).toBe(ORG_2);
  });

  it("re-running is a no-op (idempotent)", async () => {
    mockFetchAllPersonas.mockResolvedValue(PERSONAS);

    await request(app)
      .post("/internal/backfill-audiences-from-personas")
      .set(apiKeyHeader);

    const res = await request(app)
      .post("/internal/backfill-audiences-from-personas")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      dryRun: false,
      totalPersonas: 2,
      inserted: 0,
      skipped: 2,
    });

    const rows = await db.select().from(audiences);
    expect(rows.length).toBe(2);
  });

  it("fails loud (502) when brand-service errors", async () => {
    mockFetchAllPersonas.mockRejectedValue(
      new BrandServiceError(500, "brand-service exploded")
    );

    const res = await request(app)
      .post("/internal/backfill-audiences-from-personas")
      .set(apiKeyHeader);

    expect(res.status).toBe(502);
  });

  it("rejects an unauthenticated caller (401)", async () => {
    const res = await request(app).post(
      "/internal/backfill-audiences-from-personas"
    );
    expect(res.status).toBe(401);
  });
});
