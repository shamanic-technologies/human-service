import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/db/index.js";
import { brandSuppressions, leadServes } from "../../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import {
  recordServe,
  filterSuppressed,
  getSuppressionSet,
  isEmailSuppressed,
  type ServedContact,
} from "../../src/services/suppression.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const BRAND_A = "aaaaaaaa-1111-4111-8111-111111111111";
const BRAND_B = "bbbbbbbb-1111-4111-8111-111111111111";

const apolloContact = (over: Partial<ServedContact> = {}): ServedContact => ({
  email: "sara@casco.com",
  linkedinUrl: "https://www.linkedin.com/in/sara/",
  firstName: "Sara",
  lastName: "F",
  companyDomain: "casco.com",
  provider: "apollo",
  providerPersonId: "apollo-1",
  ...over,
});

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

describe("recordServe → bronze + silver", () => {
  it("writes one bronze row and one silver row per atomic brand", async () => {
    await recordServe(ORG, [BRAND_A, BRAND_B], [apolloContact()], { campaignId: "c1", runId: "r1" });

    const bronze = await db.select().from(leadServes).where(eq(leadServes.orgId, ORG));
    expect(bronze).toHaveLength(2); // brand A + brand B
    expect(bronze.every((r) => r.email === "sara@casco.com")).toBe(true);

    const silver = await db.select().from(brandSuppressions).where(eq(brandSuppressions.orgId, ORG));
    expect(silver).toHaveLength(2);
    expect(silver.every((r) => r.emailNorm === "sara@casco.com")).toBe(true);
    expect(silver.every((r) => r.linkedinUrlNorm === "linkedin.com/in/sara")).toBe(true);
  });

  it("is idempotent on (org, brand, email_norm) — re-serve updates, no dup", async () => {
    await recordServe(ORG, [BRAND_A], [apolloContact()]);
    await recordServe(ORG, [BRAND_A], [apolloContact({ email: "SARA@casco.com" })]);
    const silver = await db.select().from(brandSuppressions).where(eq(brandSuppressions.orgId, ORG));
    expect(silver).toHaveLength(1); // normalized email collapses the two
  });

  it("backfills linkedin/person-id when a later serve learns them", async () => {
    // First serve (apify) has no person id; second (apollo) adds it.
    await recordServe(ORG, [BRAND_A], [apolloContact({ provider: "apify", providerPersonId: null, linkedinUrl: null })]);
    await recordServe(ORG, [BRAND_A], [apolloContact()]);
    const [row] = await db.select().from(brandSuppressions).where(eq(brandSuppressions.orgId, ORG));
    expect(row.providerPersonId).toBe("apollo-1");
    expect(row.linkedinUrlNorm).toBe("linkedin.com/in/sara");
  });
});

describe("filterSuppressed (apollo teaser, free pre-pay)", () => {
  it("drops a teaser already served for the brand (linkedin match)", async () => {
    await recordServe(ORG, [BRAND_A], [apolloContact()]);
    const teasers = [
      { linkedinUrl: "http://linkedin.com/in/sara", providerPersonId: "z9" }, // same person, different spelling
      { linkedinUrl: "https://linkedin.com/in/fresh", providerPersonId: "z10" }, // fresh
    ];
    const fresh = await filterSuppressed(ORG, [BRAND_A], teasers);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].providerPersonId).toBe("z10");
  });

  it("drops a teaser by provider_person_id match", async () => {
    await recordServe(ORG, [BRAND_A], [apolloContact({ linkedinUrl: null })]);
    const fresh = await filterSuppressed(ORG, [BRAND_A], [
      { linkedinUrl: null, providerPersonId: "apollo-1" },
    ]);
    expect(fresh).toHaveLength(0);
  });

  it("cross-provider: apify-served lead excluded from an apollo search by linkedin", async () => {
    await recordServe(ORG, [BRAND_A], [apolloContact({ provider: "apify", providerPersonId: null })]);
    const fresh = await filterSuppressed(ORG, [BRAND_A], [
      { linkedinUrl: "https://www.linkedin.com/in/sara", providerPersonId: "apollo-xyz" },
    ]);
    expect(fresh).toHaveLength(0);
  });

  it("a different brand is NOT suppressed", async () => {
    await recordServe(ORG, [BRAND_A], [apolloContact()]);
    const fresh = await filterSuppressed(ORG, [BRAND_B], [
      { linkedinUrl: "https://linkedin.com/in/sara", providerPersonId: "apollo-1" },
    ]);
    expect(fresh).toHaveLength(1);
  });
});

describe("getSuppressionSet (apify exclude-set)", () => {
  it("returns windowed emails + linkedin urls for the brands", async () => {
    await recordServe(ORG, [BRAND_A], [apolloContact()]);
    const set = await getSuppressionSet(ORG, [BRAND_A]);
    expect(set.emails).toEqual(["sara@casco.com"]);
    expect(set.linkedinUrls).toEqual(["linkedin.com/in/sara"]);
  });

  it("multi-brand request unions both brands' suppressions", async () => {
    await recordServe(ORG, [BRAND_A], [apolloContact({ email: "a@x.com", linkedinUrl: null })]);
    await recordServe(ORG, [BRAND_B], [apolloContact({ email: "b@x.com", linkedinUrl: null })]);
    const set = await getSuppressionSet(ORG, [BRAND_A, BRAND_B]);
    expect(new Set(set.emails)).toEqual(new Set(["a@x.com", "b@x.com"]));
  });
});

describe("3-month window", () => {
  it("a serve older than 3 months does NOT suppress", async () => {
    await recordServe(ORG, [BRAND_A], [apolloContact()]);
    // Backdate the silver row ~4 months (beyond the 3-month window).
    const fourMonthsAgo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    await db
      .update(brandSuppressions)
      .set({ lastServedAt: fourMonthsAgo })
      .where(and(eq(brandSuppressions.orgId, ORG), eq(brandSuppressions.brandId, BRAND_A)));

    expect(await isEmailSuppressed(ORG, [BRAND_A], "sara@casco.com")).toBe(false);
    const set = await getSuppressionSet(ORG, [BRAND_A]);
    expect(set.emails).toHaveLength(0);
    const fresh = await filterSuppressed(ORG, [BRAND_A], [
      { linkedinUrl: "https://linkedin.com/in/sara", providerPersonId: "apollo-1" },
    ]);
    expect(fresh).toHaveLength(1); // outside window → not suppressed
  });

  it("a serve inside the window DOES suppress", async () => {
    await recordServe(ORG, [BRAND_A], [apolloContact()]);
    expect(await isEmailSuppressed(ORG, [BRAND_A], "sara@casco.com")).toBe(true);
  });
});
