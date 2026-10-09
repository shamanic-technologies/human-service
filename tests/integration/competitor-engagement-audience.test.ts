// The competitor-engagement lists we create for every client brand, one per
// client PROFILE (profile-sources.ts): at portfolio launch, and on the sweep for
// existing / not-yet-computed brands.
// Free at creation (apollo-service persists the criterion only), never
// duplicated, never from client input, never from an invented page. The LLM /
// Apollo / brand-service / billing / runs calls are mocked at their modules.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences, leadServes, sourceCampaignAudienceHolds } from "../../src/db/schema.js";
import { ensureTargetText } from "../../src/services/audience-target-text.js";
import { draftAudienceTarget } from "../../src/services/audience-target.js";
import { proposeAudienceSplit } from "../../src/services/audience-split.js";
import { settlePortfolioBackground } from "../../src/services/audience-portfolio.js";
import {
  createApolloLinkedinEngagementAudience,
  measureSignalCoverage,
  suggestApolloAudience,
} from "../../src/lib/apollo-audiences.js";
import { discoverBrandCompetitors } from "../../src/lib/brand-competitors.js";
import { getPaymentOutlook } from "../../src/lib/billing-outlook.js";
import { loadBrandPools } from "../../src/services/audience-refill.js";
import { BrandServiceError } from "../../src/lib/brand-offers.js";

vi.mock("../../src/services/audience-target.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-target.js")>()),
  draftAudienceTarget: vi.fn(),
}));
vi.mock("../../src/services/audience-split.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-split.js")>()),
  proposeAudienceSplit: vi.fn(),
}));
vi.mock("../../src/lib/apollo-audiences.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/apollo-audiences.js")>()),
  suggestApolloAudience: vi.fn(),
  measureSignalCoverage: vi.fn(),
  createApolloSignalAudience: vi.fn(),
  createApolloLinkedinEngagementAudience: vi.fn(),
}));
vi.mock("../../src/services/audiences.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audiences.js")>()),
  ensureApolloPointer: vi.fn(async (row: { name: string; apolloAudienceId: string | null }) => ({
    ...row,
    apolloAudienceId: row.apolloAudienceId ?? `apollo-${row.name}`,
  })),
}));
vi.mock("../../src/services/audience-target-text.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-target-text.js")>()),
  ensureTargetText: vi.fn(),
}));
vi.mock("../../src/lib/brand-competitors.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/brand-competitors.js")>()),
  discoverBrandCompetitors: vi.fn(),
}));
vi.mock("../../src/lib/billing-outlook.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/billing-outlook.js")>()),
  getPaymentOutlook: vi.fn(),
}));
vi.mock("../../src/services/runs.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/runs.js")>()),
  createRun: vi.fn(async () => "00000000-0000-4000-8000-00000000aaaa"),
  completeRun: vi.fn(async () => undefined),
}));

const app = createTestApp();
const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";
const BRAND = "00000000-0000-4000-8000-0000000000b1";
const OFFER = "00000000-0000-4000-8000-0000000000c1";
const ICP = "Founders of B2B SaaS companies in the US and Europe";
const DRAFTED = "Founders and CEOs of B2B SaaS companies in the US and Europe.";
const PAGES = [
  "https://www.linkedin.com/company/lemlist/",
  "https://www.linkedin.com/company/instantly/",
  "https://www.linkedin.com/company/smartlead/",
];

function launch() {
  return request(app)
    .post("/orgs/audiences/portfolio")
    .set(getAuthHeaders())
    .send({ brandId: BRAND, offerId: OFFER, targetAudience: ICP });
}

async function launched() {
  const first = await launch();
  expect(first.status).toBe(200);
  await settlePortfolioBackground();
  const done = await launch();
  expect(done.body.status).toBe("ready");
  return done;
}

function computed(urls: Array<string | null>) {
  return {
    status: "computed" as const,
    competitors: urls.map((u, i) => ({ name: `Competitor ${i}`, domain: `c${i}.com`, linkedinUrl: u })),
  };
}

async function engagementRows(offerId: string | null = OFFER) {
  return db
    .select()
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, ORG),
        eq(audiences.brandId, BRAND),
        ...(offerId ? [eq(audiences.offerId, offerId)] : []),
        eq(audiences.source, "linkedin_engagement_signal")
      )
    );
}

beforeEach(async () => {
  vi.mocked(draftAudienceTarget).mockReset().mockResolvedValue(DRAFTED);
  vi.mocked(ensureTargetText).mockReset().mockImplementation(async (row) => row.targetText ?? `Own text of ${row.name}`);
  vi.mocked(proposeAudienceSplit).mockReset().mockResolvedValue({
    axes: ["geography"],
    segments: [
      { name: "US SaaS founders", description: "Founders of B2B SaaS companies in the US.", icon: "x", iconConfidence: 1, estimatedLeadCount: null },
    ],
  });
  vi.mocked(suggestApolloAudience).mockReset().mockResolvedValue({
    apolloAudienceId: "11111111-0000-4000-8000-000000000001",
    filters: { person_titles: ["founder"] },
    count: 40_000,
    status: null,
    degraded: false,
    candidates: [],
  });
  // Every buying signal below threshold: this suite is about the engagement audience.
  vi.mocked(measureSignalCoverage).mockReset().mockResolvedValue({
    baseCount: 1000,
    signals: (["hiring", "job_change", "funding"] as const).flatMap((type) =>
      [30, 90].map((windowDays) => ({ type, windowDays, count: 3, companies: 1, companiesExact: true }))
    ),
  });
  vi.mocked(createApolloLinkedinEngagementAudience).mockReset().mockImplementation(async (a) => ({
    apolloAudienceId: "33333333-0000-4000-8000-000000000001",
    name: a.name ?? "Engaged with competitor posts",
    description: "People who reacted to or commented on a LinkedIn post by lemlist.",
    filters: { buying_signal: { type: "linkedin_engagement", window_days: a.windowDays, competitor_pages: a.competitorPages } },
  }));
  vi.mocked(discoverBrandCompetitors).mockReset().mockResolvedValue(computed([PAGES[0], null, PAGES[1], PAGES[2], "https://www.linkedin.com/company/fourth/"]));
  vi.mocked(getPaymentOutlook).mockReset().mockResolvedValue({ orgId: ORG, state: "will_charge" } as never);
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

describe("competitor-engagement audience at portfolio launch", () => {
  it("creates ONE active list per profile from up to 3 competitor pages, screened on the profile's text, visible in the list", async () => {
    const res = await launched();
    const profile = res.body.audiences[0];
    const rows = await engagementRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.status).toBe("active");
    expect(row.profileAudienceId).toBe(profile.id);
    // A one-segment split: the profile's own text IS the drafted target.
    expect(row.nlPrompt).toBe(profile.targetText);
    expect(row.targetText).toBe(DRAFTED);
    expect(row.name).toBe("US SaaS founders (Engaged with competitor posts)");
    // Free at creation: no Apollo count was read.
    expect(row.apolloCount).toBeNull();
    const call = vi.mocked(createApolloLinkedinEngagementAudience).mock.calls[0][0];
    expect(call.competitorPages).toEqual(PAGES);
    expect(call.windowDays).toBe(30);
    expect(call.baseFilters).toEqual({});

    const list = await request(app).get(`/orgs/audiences?brandId=${BRAND}`).set(getAuthHeaders());
    expect(list.status).toBe(200);
    const listed = (list.body.audiences as Array<{ id: string; source: string }>).find((a) => a.id === row.id);
    expect(listed?.source).toBe("linkedin_engagement_signal");
  });

  it("a second launch never duplicates it", async () => {
    await launched();
    await launched();
    expect(await engagementRows()).toHaveLength(1);
    expect(vi.mocked(createApolloLinkedinEngagementAudience)).toHaveBeenCalledTimes(1);
  });

  it("no competitor page found: no audience, the launch still succeeds", async () => {
    vi.mocked(discoverBrandCompetitors).mockResolvedValue(computed([null, null]));
    const res = await launched();
    expect(res.body.audiences.length).toBeGreaterThan(0);
    expect(await engagementRows()).toHaveLength(0);
    expect(vi.mocked(createApolloLinkedinEngagementAudience)).not.toHaveBeenCalled();
  });

  it("brand-service failing does not fail the launch", async () => {
    vi.mocked(discoverBrandCompetitors).mockRejectedValue(new BrandServiceError(502, "boom"));
    await launched();
    expect(await engagementRows()).toHaveLength(0);
  });

  it("competitors not computed yet: none at launch, the sweep creates it later", async () => {
    vi.mocked(discoverBrandCompetitors).mockResolvedValue({ status: "not_computed", reason: "later" });
    await launched();
    expect(await engagementRows()).toHaveLength(0);

    vi.mocked(discoverBrandCompetitors).mockResolvedValue(computed(PAGES));
    const sweep = await request(app).post(`/internal/competitor-engagement-audiences?brandId=${BRAND}`).set(getAuthHeaders());
    expect(sweep.status).toBe(200);
    expect(sweep.body.created).toBe(1);
    expect(sweep.body.entries[0]).toMatchObject({ brandId: BRAND, offerId: OFFER, action: "created", pages: PAGES });
    const rows = await engagementRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].nlPrompt).toBe(DRAFTED);
  });

  it("two profiles get one list each, from ONE competitor discovery", async () => {
    vi.mocked(proposeAudienceSplit).mockResolvedValue({
      axes: ["seniority_role"],
      segments: [
        { name: "Heads of QA", description: "Heads of QA at B2B software companies.", icon: "x", iconConfidence: 1, estimatedLeadCount: null },
        { name: "CTOs", description: "CTOs at B2B software companies.", icon: "y", iconConfidence: 1, estimatedLeadCount: null },
      ],
    });
    const res = await launched();
    const ids = res.body.audiences.filter((a: { kind: string }) => a.kind === "cold").map((a: { id: string }) => a.id);
    const rows = await engagementRows();
    expect(rows.map((r) => r.profileAudienceId).sort()).toEqual([...ids].sort());
    expect(rows.map((r) => r.nlPrompt).sort()).toEqual(["Own text of CTOs", "Own text of Heads of QA"]);
    expect(vi.mocked(discoverBrandCompetitors)).toHaveBeenCalledTimes(1);
  });
});

describe("POST /internal/competitor-engagement-audiences (sweep)", () => {
  async function seedCold(orgId = ORG) {
    const [row] = await db
      .insert(audiences)
      .values({
        orgId,
        brandId: BRAND,
        offerId: OFFER,
        name: "US SaaS founders",
        nlPrompt: DRAFTED,
        provider: "apollo",
        apolloAudienceId: "apollo-1",
        filters: { q: "x" },
        apolloCount: 5000,
        status: "active",
        source: "split_proposal",
        createdByUserId: USER,
      })
      .returning();
    return row;
  }

  it("an org billing cannot charge gets nothing, and brand-service is never asked", async () => {
    await seedCold();
    vi.mocked(getPaymentOutlook).mockResolvedValue({ orgId: ORG, state: "no_autopay" } as never);
    const res = await request(app).post("/internal/competitor-engagement-audiences").set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({ action: "skipped", reason: "not_chargeable: no_autopay" });
    expect(vi.mocked(discoverBrandCompetitors)).not.toHaveBeenCalled();
    expect(await engagementRows()).toHaveLength(0);
  });

  it("dry run reports and creates nothing", async () => {
    await seedCold();
    const res = await request(app).post("/internal/competitor-engagement-audiences?dryRun=true").set(getAuthHeaders());
    expect(res.body.entries[0].action).toBe("would_ensure");
    expect(vi.mocked(discoverBrandCompetitors)).not.toHaveBeenCalled();
    expect(await engagementRows()).toHaveLength(0);
  });

  it("an offer's whole-ICP list is replaced: each profile gets its own in the same state (paused + its source hold), the whole-ICP one is archived", async () => {
    const profile = await seedCold();
    const [legacy] = await db
      .insert(audiences)
      .values({
        orgId: ORG,
        brandId: BRAND,
        offerId: OFFER,
        name: "Engaged with competitor posts",
        nlPrompt: "VPs of Engineering, Heads of QA, and CTOs",
        provider: "apollo",
        apolloAudienceId: "apollo-legacy",
        filters: { buying_signal: { type: "linkedin_engagement", window_days: 30, competitor_pages: PAGES } },
        status: "paused",
        source: "linkedin_engagement_signal",
        createdByUserId: USER,
      })
      .returning();
    await db.insert(sourceCampaignAudienceHolds).values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      originSlug: "sourcing-linkedin-engagement-signals",
      audienceId: legacy.id,
      campaignId: "camp-1",
    });
    const res = await request(app).post("/internal/competitor-engagement-audiences").set(getAuthHeaders());
    expect(res.body.entries[0].action).toBe("created");
    const rows = await engagementRows();
    const own = rows.find((r) => r.profileAudienceId === profile.id)!;
    expect(own.status).toBe("paused");
    expect(rows.find((r) => r.id === legacy.id)!.status).toBe("archived");
    const holds = await db.select().from(sourceCampaignAudienceHolds).where(eq(sourceCampaignAudienceHolds.audienceId, own.id));
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ originSlug: "sourcing-linkedin-engagement-signals", campaignId: "camp-1" });
  });

  it("an existing brand gets it once; the next sweep reports it exists", async () => {
    await seedCold();
    const first = await request(app).post("/internal/competitor-engagement-audiences").set(getAuthHeaders());
    expect(first.body.entries[0].action).toBe("created");
    const second = await request(app).post("/internal/competitor-engagement-audiences").set(getAuthHeaders());
    expect(second.body.entries[0].action).toBe("exists");
    expect(await engagementRows()).toHaveLength(1);
    expect(vi.mocked(createApolloLinkedinEngagementAudience)).toHaveBeenCalledTimes(1);
  });
});

describe("refill pool measure with an unsized engagement audience", () => {
  it("measures the brand on its other audiences instead of skipping it", async () => {
    const [cold] = await db
      .insert(audiences)
      .values({
        orgId: ORG,
        brandId: BRAND,
        offerId: OFFER,
        name: "US SaaS founders",
        nlPrompt: DRAFTED,
        provider: "apollo",
        apolloAudienceId: "apollo-1",
        filters: { q: "x" },
        apolloCount: 5000,
        status: "active",
        source: "split_proposal",
        createdByUserId: USER,
      })
      .returning();
    await db.insert(audiences).values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      name: "Engaged with competitor posts",
      nlPrompt: DRAFTED,
      provider: "apollo",
      apolloAudienceId: "apollo-2",
      filters: { buying_signal: { type: "linkedin_engagement", window_days: 30, competitor_pages: PAGES } },
      apolloCount: null,
      status: "active",
      source: "linkedin_engagement_signal",
      createdByUserId: USER,
    });
    await db.insert(leadServes).values({
      orgId: ORG,
      brandId: BRAND,
      provider: "apollo",
      email: "p1@x.test",
      audienceId: cold.id,
      emailVerdict: "valid",
      servedAt: new Date(Date.now() - 86_400_000),
    });
    const [pool] = await loadBrandPools({ brandId: BRAND });
    expect(pool.unmeasurable).toBeNull();
    expect(pool.activeAudiences).toBe(2);
  });
});
