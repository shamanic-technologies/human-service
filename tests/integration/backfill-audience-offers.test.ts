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

// One brand, claimed by two orgs — each holds its OWN offer for it. That is the
// whole reason attribution keys on the pair rather than on the brand.
const ORG_A = "a0000000-0000-4000-8000-0000000000a1";
const ORG_B = "a0000000-0000-4000-8000-0000000000b1";
const ORG_NO_OFFER = "a0000000-0000-4000-8000-0000000000c1";
const ORG_TWO_OFFERS = "a0000000-0000-4000-8000-0000000000d1";
const BRAND = "b0000000-0000-4000-8000-00000000000a";

const OFFER_A = "e0000000-0000-4000-8000-0000000000a1";
const OFFER_B = "e0000000-0000-4000-8000-0000000000b1";
const OFFER_D1 = "e0000000-0000-4000-8000-0000000000d1";
const OFFER_D2 = "e0000000-0000-4000-8000-0000000000d2";

const AUD_A1 = "c0000000-0000-4000-8000-000000000001";
const AUD_A2 = "c0000000-0000-4000-8000-000000000002";
const AUD_B1 = "c0000000-0000-4000-8000-000000000003";
const AUD_NO_OFFER = "c0000000-0000-4000-8000-000000000004";
const AUD_TWO_OFFERS = "c0000000-0000-4000-8000-000000000005";
const AUD_ALREADY = "c0000000-0000-4000-8000-000000000006";

// (org, brand) -> the offers brand-service reports for that pair.
const OFFERS_BY_PAIR: Record<string, string[]> = {
  [ORG_A]: [OFFER_A],
  [ORG_B]: [OFFER_B],
  [ORG_NO_OFFER]: [],
  [ORG_TWO_OFFERS]: [OFFER_D1, OFFER_D2],
};

let fetchSpy: ReturnType<typeof vi.fn>;

function stubBrandService() {
  fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    const orgId = (init?.headers as Record<string, string>)["x-org-id"];
    expect(String(url)).toContain(`/internal/brands/${BRAND}/offers`);
    const offers = (OFFERS_BY_PAIR[orgId] ?? []).map((offerId) => ({
      offerId,
      brandId: BRAND,
      name: `Offer ${offerId.slice(-2)}`,
    }));
    return new Response(JSON.stringify({ offers }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
}

async function seed() {
  await db.insert(audiences).values([
    { id: AUD_A1, orgId: ORG_A, brandId: BRAND, name: "Doc Dinners US", provider: "apollo" },
    { id: AUD_A2, orgId: ORG_A, brandId: BRAND, name: "Doc Dinners EU", provider: "apollo" },
    { id: AUD_B1, orgId: ORG_B, brandId: BRAND, name: "Other Org List", provider: "apollo" },
    { id: AUD_NO_OFFER, orgId: ORG_NO_OFFER, brandId: BRAND, name: "Orphan List", provider: "apollo" },
    { id: AUD_TWO_OFFERS, orgId: ORG_TWO_OFFERS, brandId: BRAND, name: "Ambiguous List", provider: "apollo" },
    // Already attributed (post-#223) — must never be re-read or re-written.
    {
      id: AUD_ALREADY,
      orgId: ORG_A,
      brandId: BRAND,
      name: "Already Scoped",
      provider: "apollo",
      offerId: OFFER_A,
    },
  ]);
}

async function offerOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ offerId: audiences.offerId })
    .from(audiences)
    .where(eq(audiences.id, id));
  return row.offerId;
}

beforeEach(async () => {
  await cleanTestData();
  process.env.BRAND_SERVICE_URL = "https://brand.test";
  process.env.BRAND_SERVICE_API_KEY = "brand-key";
  // Stub inside beforeEach, never at describe-body eval — one shared global.
  stubBrandService();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await cleanTestData();
  await closeDb();
});

describe("POST /internal/backfill-audience-offers", () => {
  it("requires api key", async () => {
    const res = await request(app).post("/internal/backfill-audience-offers");
    expect(res.status).toBe(401);
  });

  it("dry-run resolves the full mapping WITHOUT writing", async () => {
    await seed();
    const res = await request(app)
      .post("/internal/backfill-audience-offers?dryRun=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.scanned).toBe(5); // the already-scoped row is out of scope
    expect(res.body.pairs).toBe(4);
    expect(res.body.wouldAttribute).toBe(3); // ORG_A x2 + ORG_B x1
    expect(res.body.attributed).toBe(0);
    expect(res.body.unattributed).toBe(2);
    expect(res.body.assignments).toHaveLength(3);

    // Nothing written.
    expect(await offerOf(AUD_A1)).toBeNull();
    expect(await offerOf(AUD_B1)).toBeNull();
  });

  it("attributes each audience to its own (org, brand) offer, never the brand's other org's", async () => {
    await seed();
    const res = await request(app)
      .post("/internal/backfill-audience-offers?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.attributed).toBe(3);
    expect(res.body.unattributed).toBe(2);

    expect(await offerOf(AUD_A1)).toBe(OFFER_A);
    expect(await offerOf(AUD_A2)).toBe(OFFER_A);
    // Same brand, different org — its own offer, not ORG_A's.
    expect(await offerOf(AUD_B1)).toBe(OFFER_B);
    expect(await offerOf(AUD_ALREADY)).toBe(OFFER_A);

    // The full mapping is returned — it is the reversal set.
    const ids = res.body.assignments.map((a: { audienceId: string }) => a.audienceId).sort();
    expect(ids).toEqual([AUD_A1, AUD_A2, AUD_B1].sort());
  });

  it("leaves a pair with no offer, and a pair with several, untouched and reported", async () => {
    await seed();
    const res = await request(app)
      .post("/internal/backfill-audience-offers?dryRun=false")
      .set(apiKeyHeader);

    expect(await offerOf(AUD_NO_OFFER)).toBeNull();
    expect(await offerOf(AUD_TWO_OFFERS)).toBeNull();

    const reasons = Object.fromEntries(
      res.body.skipped.map((s: { orgId: string; reason: string }) => [s.orgId, s.reason])
    );
    expect(reasons[ORG_NO_OFFER]).toBe("no offer");
    expect(reasons[ORG_TWO_OFFERS]).toBe("several offers (2)");
    expect(res.body.unattributed).toBe(2);
  });

  it("re-running changes nothing", async () => {
    await seed();
    await request(app)
      .post("/internal/backfill-audience-offers?dryRun=false")
      .set(apiKeyHeader);

    const reRun = await request(app)
      .post("/internal/backfill-audience-offers?dryRun=false")
      .set(apiKeyHeader);

    expect(reRun.body.scanned).toBe(2); // only the two honest gaps remain
    expect(reRun.body.attributed).toBe(0);
    expect(reRun.body.assignments).toHaveLength(0);
    expect(await offerOf(AUD_A1)).toBe(OFFER_A);
  });

  it("counts a brand-service read failure as a skipped pair and leaves its rows null", async () => {
    await seed();
    fetchSpy.mockImplementation(async () => new Response("boom", { status: 500 }));

    const res = await request(app)
      .post("/internal/backfill-audience-offers?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.attributed).toBe(0);
    expect(res.body.unattributed).toBe(5);
    expect(res.body.skipped).toHaveLength(4);
    expect(res.body.skipped[0].reason).toContain("brand-service 500");
    expect(await offerOf(AUD_A1)).toBeNull();
  });

  it("fails loud (502) when brand-service is not configured", async () => {
    await seed();
    delete process.env.BRAND_SERVICE_URL;

    const res = await request(app)
      .post("/internal/backfill-audience-offers?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(502);
    expect(await offerOf(AUD_A1)).toBeNull();

    process.env.BRAND_SERVICE_URL = "https://brand.test";
  });
});
