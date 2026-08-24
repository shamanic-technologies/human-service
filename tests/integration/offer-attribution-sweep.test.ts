import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { runOfferAttributionSweep } from "../../src/services/offer-attribution-sweep.js";

// Same fixture shape as the manual sweep's test: ONE brand claimed by several
// orgs, each holding its own offer. The recurring sweep must reach exactly the
// same answers — this is about WHEN the repair runs, not what it guesses.
const ORG_A = "a0000000-0000-4000-8000-0000000000a1";
const ORG_B = "a0000000-0000-4000-8000-0000000000b1";
const ORG_NO_OFFER = "a0000000-0000-4000-8000-0000000000c1";
const ORG_TWO_OFFERS = "a0000000-0000-4000-8000-0000000000d1";
const BRAND = "b0000000-0000-4000-8000-00000000000a";

const OFFER_A = "e0000000-0000-4000-8000-0000000000a1";
const OFFER_B = "e0000000-0000-4000-8000-0000000000b1";

const AUD_A1 = "c0000000-0000-4000-8000-000000000001";
const AUD_B1 = "c0000000-0000-4000-8000-000000000003";
const AUD_NO_OFFER = "c0000000-0000-4000-8000-000000000004";
const AUD_TWO_OFFERS = "c0000000-0000-4000-8000-000000000005";

const OFFERS_BY_ORG: Record<string, string[]> = {
  [ORG_A]: [OFFER_A],
  [ORG_B]: [OFFER_B],
  [ORG_NO_OFFER]: [],
  [ORG_TWO_OFFERS]: [
    "e0000000-0000-4000-8000-0000000000d1",
    "e0000000-0000-4000-8000-0000000000d2",
  ],
};

function stubBrandService() {
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    const orgId = (init?.headers as Record<string, string>)["x-org-id"];
    const offers = (OFFERS_BY_ORG[orgId] ?? []).map((offerId) => ({
      offerId,
      brandId: BRAND,
      name: "Offer",
    }));
    return new Response(JSON.stringify({ offers }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
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
  await db.insert(audiences).values([
    { id: AUD_A1, orgId: ORG_A, brandId: BRAND, name: "Born Before Its Offer", provider: "apollo" },
    { id: AUD_B1, orgId: ORG_B, brandId: BRAND, name: "Other Org List", provider: "apollo" },
    { id: AUD_NO_OFFER, orgId: ORG_NO_OFFER, brandId: BRAND, name: "Orphan List", provider: "apollo" },
    { id: AUD_TWO_OFFERS, orgId: ORG_TWO_OFFERS, brandId: BRAND, name: "Ambiguous List", provider: "apollo" },
  ]);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await cleanTestData();
  await closeDb();
});

describe("recurring offer attribution sweep", () => {
  it("attributes an audience born before its brand's offer, with no manual trigger", async () => {
    const res = await runOfferAttributionSweep();

    expect(res?.attributed).toBe(2);
    expect(await offerOf(AUD_A1)).toBe(OFFER_A);
    // Same brand, different org — its OWN offer, never the other org's.
    expect(await offerOf(AUD_B1)).toBe(OFFER_B);
  });

  it("leaves a pair with no offer, and one with several, null and counted", async () => {
    const res = await runOfferAttributionSweep();

    expect(await offerOf(AUD_NO_OFFER)).toBeNull();
    expect(await offerOf(AUD_TWO_OFFERS)).toBeNull();
    const reasons = Object.fromEntries(res!.skipped.map((s) => [s.orgId, s.reason]));
    expect(reasons[ORG_NO_OFFER]).toBe("no offer");
    expect(reasons[ORG_TWO_OFFERS]).toBe("several offers (2)");
    expect(res?.unattributed).toBe(2);
  });

  it("is idempotent — a second tick attributes nothing more", async () => {
    await runOfferAttributionSweep();
    const second = await runOfferAttributionSweep();

    expect(second?.attributed).toBe(0);
    expect(second?.scanned).toBe(2); // only the two honest gaps remain
    expect(await offerOf(AUD_A1)).toBe(OFFER_A);
  });

  it("picks a brand up on a LATER tick, once its offer finally exists", async () => {
    await runOfferAttributionSweep();
    expect(await offerOf(AUD_NO_OFFER)).toBeNull();

    // The funnels write lands after onboarding — the brand now has one offer.
    const LATE_OFFER = "e0000000-0000-4000-8000-0000000000f1";
    OFFERS_BY_ORG[ORG_NO_OFFER] = [LATE_OFFER];
    try {
      const res = await runOfferAttributionSweep();
      expect(res?.attributed).toBe(1);
      expect(await offerOf(AUD_NO_OFFER)).toBe(LATE_OFFER);
    } finally {
      OFFERS_BY_ORG[ORG_NO_OFFER] = [];
    }
  });
});
