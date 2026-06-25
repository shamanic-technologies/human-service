import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
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
const USER = "a0000000-0000-4000-8000-000000000002";
const APOLLO_NOPTR = "d0000000-0000-4000-8000-000000000001";
const APOLLO_HASPTR = "d0000000-0000-4000-8000-000000000002";
const APIFY_ROW = "d0000000-0000-4000-8000-000000000003";
const APOLLO_DEPRECATED = "d0000000-0000-4000-8000-000000000004";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

interface ApolloResp {
  apolloAudienceId: string;
  filters: Record<string, unknown>;
  count: number;
}

function wire(opts?: { byName?: (name: string) => ApolloResp }) {
  let seq = 0;
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/audiences/suggest-from-segment")) {
      const body = JSON.parse(init.body ?? "{}") as { name: string };
      if (opts?.byName) return ok(opts.byName(body.name));
      return ok({
        apolloAudienceId: `apollo-ptr-${++seq}`,
        filters: { personTitles: ["Faithful"] },
        count: 4242,
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

async function seed() {
  await db.insert(audiences).values([
    {
      id: APOLLO_NOPTR,
      orgId: ORG,
      brandId: BRAND,
      name: "Apollo No Pointer",
      description: "apollo audience without a pointer",
      provider: "apollo",
      status: "active",
      filters: { titles: ["CEO"] }, // old neutral blob to be replaced
      createdByUserId: USER,
    },
    {
      id: APOLLO_HASPTR,
      orgId: ORG,
      brandId: BRAND,
      name: "Apollo Has Pointer",
      provider: "apollo",
      apolloAudienceId: "already-pointed",
      status: "active",
      filters: { personTitles: ["Untouched"] },
      createdByUserId: USER,
    },
    {
      id: APIFY_ROW,
      orgId: ORG,
      brandId: BRAND,
      name: "Apify Legacy",
      provider: "apify",
      status: "active",
      filters: { titles: ["X"] },
      createdByUserId: USER,
    },
    {
      id: APOLLO_DEPRECATED,
      orgId: ORG,
      brandId: BRAND,
      name: "Apollo Dead",
      provider: "apollo",
      status: "deprecated",
      filters: { titles: ["Y"] },
      createdByUserId: USER,
    },
  ]);
}

beforeEach(async () => {
  fetchSpy.mockReset();
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /internal/backfill-apollo-audience-pointers", () => {
  it("dry-run scans pointer-less apollo rows only, calls nothing, writes nothing", async () => {
    await seed();
    wire();

    const res = await request(app)
      .post("/internal/backfill-apollo-audience-pointers?dryRun=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    // Only the apollo row WITHOUT a pointer (not the pointed one, not apify, not deprecated).
    expect(res.body.scanned).toBe(1);
    expect(res.body.wouldBackfill).toBe(1);
    expect(res.body.backfilled).toEqual([]);
    expect(res.body.sample).toHaveLength(1);
    expect(res.body.sample[0].id).toBe(APOLLO_NOPTR);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("real run stores the apollo pointer + cached faithful filters + count; re-run is idempotent", async () => {
    await seed();
    wire({
      byName: () => ({
        apolloAudienceId: "apollo-faithful-1",
        filters: { personTitles: ["VP Sales"], revenueRange: ["1000000,5000000"] },
        count: 888,
      }),
    });

    const res = await request(app)
      .post("/internal/backfill-apollo-audience-pointers?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.backfilled).toHaveLength(1);
    expect(res.body.failed).toEqual([]);
    expect(res.body.backfilled[0]).toMatchObject({
      id: APOLLO_NOPTR,
      apolloAudienceId: "apollo-faithful-1",
      count: 888,
    });

    // The row now carries the pointer + the faithful filters (old neutral blob gone) + count.
    const [row] = await db.select().from(audiences).where(eq(audiences.id, APOLLO_NOPTR));
    expect(row.apolloAudienceId).toBe("apollo-faithful-1");
    expect(row.filters).toEqual({
      personTitles: ["VP Sales"],
      revenueRange: ["1000000,5000000"],
    });
    expect(row.apolloCount).toBe(888);

    // The already-pointed apollo row is untouched.
    const [pointed] = await db.select().from(audiences).where(eq(audiences.id, APOLLO_HASPTR));
    expect(pointed.apolloAudienceId).toBe("already-pointed");
    expect(pointed.filters).toEqual({ personTitles: ["Untouched"] });

    // Re-run: nothing left without a pointer.
    const reRun = await request(app)
      .post("/internal/backfill-apollo-audience-pointers?dryRun=false")
      .set(apiKeyHeader);
    expect(reRun.body.scanned).toBe(0);
    expect(reRun.body.backfilled).toEqual([]);
  });

  it("a row whose apollo build yields no usable filters is counted failed + left untouched", async () => {
    await seed();
    wire({ byName: () => ({ apolloAudienceId: "empty", filters: {}, count: 0 }) });

    const res = await request(app)
      .post("/internal/backfill-apollo-audience-pointers?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.backfilled).toEqual([]);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe(APOLLO_NOPTR);

    // Untouched (still no pointer, original filters).
    const [row] = await db.select().from(audiences).where(eq(audiences.id, APOLLO_NOPTR));
    expect(row.apolloAudienceId).toBeNull();
    expect(row.filters).toEqual({ titles: ["CEO"] });
  });

  it("a row whose apollo build yields non-empty filters but zero count is failed + left untouched", async () => {
    await seed();
    wire({
      byName: () => ({
        apolloAudienceId: "zero-count",
        filters: { personTitles: ["Founder"] },
        count: 0,
      }),
    });

    const res = await request(app)
      .post("/internal/backfill-apollo-audience-pointers?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.backfilled).toEqual([]);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0]).toMatchObject({
      id: APOLLO_NOPTR,
      error: expect.stringContaining("unusable audience build"),
    });

    const [row] = await db.select().from(audiences).where(eq(audiences.id, APOLLO_NOPTR));
    expect(row.apolloAudienceId).toBeNull();
    expect(row.filters).toEqual({ titles: ["CEO"] });
    expect(row.apolloCount).toBeNull();
  });

  it("fails loud (502) on missing apollo config (truly systemic)", async () => {
    await seed();
    wire();
    delete process.env.APOLLO_SERVICE_URL;

    const res = await request(app)
      .post("/internal/backfill-apollo-audience-pointers?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(502);
  });

  it("requires api key", async () => {
    const res = await request(app).post(
      "/internal/backfill-apollo-audience-pointers"
    );
    expect(res.status).toBe(401);
  });
});
