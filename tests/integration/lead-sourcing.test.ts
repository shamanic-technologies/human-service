// LEAD SOURCING (owner 2026-10-11): the sourcing channel that PICKS its sources. While its campaign is ON, the
// origins this service chose for the brand are ON exactly as if their own source campaigns were. The migration
// case: a funnel running three sources moves to Lead Sourcing (their campaigns OFF, Lead Sourcing ON in one
// transaction): nothing the client has changes. src/services/lead-sourcing.ts + source-campaigns.ts.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences, leadSourcingChoiceChanges, leadSourcingChoices, sourceCampaignStates } from "../../src/db/schema.js";
import { fetchOfferSourceCampaigns, type OfferSourceCampaign } from "../../src/lib/campaign-source-campaigns.js";
import { fetchOfferSourcingEvidence } from "../../src/lib/features-offer-sourcing.js";

vi.mock("../../src/lib/campaign-source-campaigns.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/campaign-source-campaigns.js")>()),
  fetchOfferSourceCampaigns: vi.fn(),
}));
vi.mock("../../src/lib/features-offer-sourcing.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/features-offer-sourcing.js")>()),
  fetchOfferSourcingEvidence: vi.fn(),
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
const COLD = "sourcing-apollo-cold-filters";
const SIGNALS = "sourcing-apollo-buying-signals";
const LINKEDIN = "sourcing-linkedin-engagement-signals";
const COLD_CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const SIGNALS_CAMPAIGN = "33333333-3333-4333-8333-333333333333";
const LS_CAMPAIGN = "44444444-4444-4444-8444-444444444444";
const SIGNAL_FILTERS = { person_titles: ["owner"], buying_signal: { type: "hiring", window_days: 30 } };

async function insertAudience(v: { name: string; filters?: unknown; profileAudienceId?: string | null }) {
  const [row] = await db
    .insert(audiences)
    .values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      name: v.name,
      nlPrompt: "Owners of chiropractic clinics in the US.",
      provider: "apollo",
      apolloAudienceId: "99999999-0000-4000-8000-000000000001",
      filters: (v.filters ?? { person_titles: ["owner"] }) as never,
      status: "active",
      profileAudienceId: v.profileAudienceId ?? null,
      createdByUserId: USER,
    })
    .returning();
  return row;
}

async function statusOf(id: string) {
  const [row] = await db.select({ status: audiences.status }).from(audiences).where(eq(audiences.id, id));
  return row?.status;
}

function campaignSays(entries: Array<Partial<OfferSourceCampaign> & { featureSlug: string }>) {
  vi.mocked(fetchOfferSourceCampaigns).mockResolvedValue(entries.map((e) => ({ campaignId: null, status: null, running: false, ...e })));
}

function reconcile() {
  return request(app).post(`/internal/source-campaigns/reconcile?orgId=${ORG}`).set(getAuthHeaders());
}

/** The brand today: Apollo Cold Filters + Apollo Buying Signals ON, their lists active, recorded ON. */
async function brandRunningTwoSources() {
  const cold = await insertAudience({ name: "Clinic owners" });
  const signal = await insertAudience({ name: "Clinic owners (Hiring)", filters: SIGNAL_FILTERS, profileAudienceId: cold.id });
  campaignSays([
    { featureSlug: COLD, campaignId: COLD_CAMPAIGN, status: "ongoing", running: true },
    { featureSlug: SIGNALS, campaignId: SIGNALS_CAMPAIGN, status: "ongoing", running: true },
    { featureSlug: LINKEDIN },
    { featureSlug: "lead-sourcing" },
  ]);
  expect((await reconcile()).status).toBe(200);
  const states = await db.select().from(sourceCampaignStates);
  expect(states.map((s) => [s.originSlug, s.status]).sort()).toEqual([[SIGNALS, "on"], [COLD, "on"]].sort());
  return { cold, signal };
}

/** The switch, as campaign-service writes it in ONE transaction: the two sources OFF, Lead Sourcing ON. */
function switchToLeadSourcing() {
  campaignSays([
    { featureSlug: COLD, campaignId: COLD_CAMPAIGN, status: "stopped", running: false },
    { featureSlug: SIGNALS, campaignId: SIGNALS_CAMPAIGN, status: "stopped", running: false },
    { featureSlug: LINKEDIN },
    { featureSlug: "lead-sourcing", campaignId: LS_CAMPAIGN, status: "ongoing", running: true },
  ]);
}

beforeEach(async () => {
  vi.mocked(fetchOfferSourceCampaigns).mockReset();
  vi.mocked(fetchOfferSourcingEvidence).mockReset();
  await cleanTestData();
  await db.delete(leadSourcingChoiceChanges);
  await db.delete(leadSourcingChoices);
});

afterAll(async () => {
  await closeDb();
});

describe("Lead Sourcing", () => {
  it("the switch changes nothing: it keeps the sources the brand had ON, every list stays active, nothing is moved", async () => {
    const { cold, signal } = await brandRunningTwoSources();
    switchToLeadSourcing();
    const res = await reconcile();
    expect(res.status).toBe(200);
    // No transition applied: the origins were ON and still are (through Lead Sourcing).
    expect(res.body.entries.filter((e: { action: string }) => e.action !== "read_failed")).toEqual([]);
    expect(await statusOf(cold.id)).toBe("active");
    expect(await statusOf(signal.id)).toBe("active");
    const [choice] = await db.select().from(leadSourcingChoices);
    expect(choice).toMatchObject({ basis: "sources_on_at_switch", campaignId: LS_CAMPAIGN });
    expect([...choice.universeOriginSlugs].sort()).toEqual([SIGNALS, COLD].sort());
    expect([...choice.chosenOriginSlugs].sort()).toEqual([SIGNALS, COLD].sort());
    // LinkedIn was off: Lead Sourcing does not start using it.
    expect(choice.universeOriginSlugs).not.toContain(LINKEDIN);
  });

  it("GET /orgs/lead-sourcing/sources serves the choice; with a run it re-decides on measured ROI and the next reconcile applies it", async () => {
    const { cold, signal } = await brandRunningTwoSources();
    switchToLeadSourcing();
    await reconcile();

    const plain = await request(app).get(`/orgs/lead-sourcing/sources?brandId=${BRAND}&offerId=${OFFER}`).set({ "x-api-key": "test-api-key", "x-org-id": ORG });
    expect(plain.status).toBe(200);
    expect(plain.body).toMatchObject({ leadSourcingOn: true, decided: true, basis: "sources_on_at_switch", chosenOriginSlugs: [SIGNALS, COLD] });
    expect(vi.mocked(fetchOfferSourcingEvidence)).not.toHaveBeenCalled();

    // Cold filters: 8 positive replies for $630 ($78.75 each). Buying signals: $300 with none (> 3 x $78.75).
    vi.mocked(fetchOfferSourcingEvidence).mockResolvedValue(
      new Map([
        [COLD, { leadsServed: 5664, positiveReplies: 8, endToEndCostUsd: 630 }],
        [SIGNALS, { leadsServed: 2000, positiveReplies: 0, endToEndCostUsd: 300 }],
      ])
    );
    const withRun = await request(app)
      .get(`/orgs/lead-sourcing/sources?brandId=${BRAND}&offerId=${OFFER}`)
      .set({ "x-api-key": "test-api-key", "x-org-id": ORG, "x-user-id": USER, "x-run-id": "run-1" });
    expect(withRun.status).toBe(200);
    expect(withRun.body.chosenOriginSlugs).toEqual([COLD]);
    expect(withRun.body.sources.find((s: { originSlug: string }) => s.originSlug === SIGNALS)).toMatchObject({ chosen: false, reason: "spent_without_positive_reply" });
    expect(vi.mocked(fetchOfferSourcingEvidence)).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, brandId: BRAND, offerId: OFFER, userId: USER, runId: "run-1" }));
    expect(await db.select().from(leadSourcingChoiceChanges)).toHaveLength(2);

    // Within the hour: not read again.
    await request(app).get(`/orgs/lead-sourcing/sources?brandId=${BRAND}&offerId=${OFFER}`).set({ "x-api-key": "test-api-key", "x-org-id": ORG, "x-user-id": USER, "x-run-id": "run-2" });
    expect(vi.mocked(fetchOfferSourcingEvidence)).toHaveBeenCalledTimes(1);

    // The reconcile turns the dropped source's lists OFF, held under Lead Sourcing; cold filters untouched.
    const res = await reconcile();
    expect(res.body.entries).toEqual([expect.objectContaining({ originSlug: SIGNALS, status: "off", action: "paused" })]);
    expect(await statusOf(signal.id)).toBe("paused");
    expect(await statusOf(cold.id)).toBe("active");
  });

  it("Lead Sourcing OFF turns its chosen sources OFF; back ON resumes exactly those", async () => {
    const { cold, signal } = await brandRunningTwoSources();
    switchToLeadSourcing();
    await reconcile();
    campaignSays([
      { featureSlug: COLD, campaignId: COLD_CAMPAIGN, status: "stopped", running: false },
      { featureSlug: SIGNALS, campaignId: SIGNALS_CAMPAIGN, status: "stopped", running: false },
      { featureSlug: "lead-sourcing", campaignId: LS_CAMPAIGN, status: "stopped", running: false },
    ]);
    await reconcile();
    expect(await statusOf(cold.id)).toBe("paused");
    expect(await statusOf(signal.id)).toBe("paused");
    switchToLeadSourcing();
    await reconcile();
    expect(await statusOf(cold.id)).toBe("active");
    expect(await statusOf(signal.id)).toBe("active");
  });

  it("an offer whose Lead Sourcing never ran answers decided:false, nothing chosen", async () => {
    campaignSays([{ featureSlug: COLD }, { featureSlug: "lead-sourcing" }]);
    const res = await request(app).get(`/orgs/lead-sourcing/sources?brandId=${BRAND}&offerId=${OFFER}`).set({ "x-api-key": "test-api-key", "x-org-id": ORG });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ leadSourcingOn: false, decided: false, chosenOriginSlugs: [] });
  });

  it("a brand with no source on yet: Lead Sourcing may use every source it can", async () => {
    campaignSays([{ featureSlug: COLD }, { featureSlug: "lead-sourcing", campaignId: LS_CAMPAIGN, status: "ongoing", running: true }]);
    const res = await request(app).get(`/orgs/lead-sourcing/sources?brandId=${BRAND}&offerId=${OFFER}`).set({ "x-api-key": "test-api-key", "x-org-id": ORG });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ basis: "every_origin", chosenOriginSlugs: [SIGNALS, COLD, LINKEDIN] });
  });
});
