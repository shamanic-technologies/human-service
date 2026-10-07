// SOURCE CAMPAIGNS (owner 2026-10-07): a lead source of an offer is a campaign-service
// campaign. ON = its origin's audience exists for the offer and is active; OFF = paused,
// history kept, resumed by the next ON. Both the push route and the reconcile (which
// reads campaign-service) go through src/services/source-campaigns.ts. Every sibling
// (campaign-service, apollo-service, brand-service, crm-service, chat-service, runs) is
// mocked at its module.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences, sourceCampaignAudienceHolds, sourceCampaignStates } from "../../src/db/schema.js";
import { createApolloLinkedinEngagementAudience } from "../../src/lib/apollo-audiences.js";
import { discoverBrandCompetitors } from "../../src/lib/brand-competitors.js";
import { fetchOfferSourceCampaigns, type OfferSourceCampaign } from "../../src/lib/campaign-source-campaigns.js";
import { crmListUploads } from "../../src/lib/crm-contacts.js";
import { proposeAudienceSplit } from "../../src/services/audience-split.js";
import { createRun } from "../../src/services/runs.js";
import { getPaymentOutlook } from "../../src/lib/billing-outlook.js";

vi.mock("../../src/lib/apollo-audiences.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/apollo-audiences.js")>()),
  createApolloLinkedinEngagementAudience: vi.fn(),
}));
vi.mock("../../src/lib/brand-competitors.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/brand-competitors.js")>()),
  discoverBrandCompetitors: vi.fn(),
}));
vi.mock("../../src/lib/campaign-source-campaigns.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/campaign-source-campaigns.js")>()),
  fetchOfferSourceCampaigns: vi.fn(),
}));
vi.mock("../../src/lib/crm-contacts.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/crm-contacts.js")>()),
  crmListUploads: vi.fn(),
}));
vi.mock("../../src/services/audience-split.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-split.js")>()),
  proposeAudienceSplit: vi.fn(),
}));
vi.mock("../../src/services/audiences.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audiences.js")>()),
  ensureApolloPointer: vi.fn(async (row: unknown) => row),
}));
vi.mock("../../src/services/audience-target-text.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-target-text.js")>()),
  ensureTargetText: vi.fn(async (row: unknown) => row),
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
const OTHER_OFFER = "00000000-0000-4000-8000-0000000000c2";
const LINKEDIN = "sourcing-linkedin-engagement-signals";
const COLD = "sourcing-apollo-cold-filters";
const CRM = "sourcing-crm-contacts";
const LI_CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const COLD_CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const TARGET = "Owners of chiropractic clinics in the US.";
const PAGES = ["https://www.linkedin.com/company/lemlist/"];

async function insertAudience(v: {
  name: string;
  status?: string;
  offerId?: string;
  provider?: string;
  filters?: unknown;
  source?: string | null;
  crmUploadId?: string | null;
}) {
  const [row] = await db
    .insert(audiences)
    .values({
      orgId: ORG,
      brandId: BRAND,
      offerId: v.offerId ?? OFFER,
      name: v.name,
      nlPrompt: TARGET,
      provider: v.provider ?? "apollo",
      apolloAudienceId: v.provider === "crm" ? null : "99999999-0000-4000-8000-000000000001",
      filters: (v.filters ?? { person_titles: ["owner"] }) as never,
      status: v.status ?? "active",
      source: v.source ?? null,
      crmUploadId: v.crmUploadId ?? null,
      createdByUserId: USER,
    })
    .returning();
  return row;
}

const ENGAGEMENT_FILTERS = { buying_signal: { type: "linkedin_engagement", window_days: 30, competitor_pages: PAGES } };
const SIGNAL_FILTERS = { person_titles: ["owner"], buying_signal: { type: "hiring", window_days: 30 } };

function push(body: Record<string, unknown>) {
  return request(app)
    .post("/orgs/source-campaigns/state")
    .set(getAuthHeaders())
    .send({ brandId: BRAND, offerId: OFFER, campaignId: LI_CAMPAIGN, ...body });
}

async function statusOf(id: string) {
  const [row] = await db.select({ status: audiences.status }).from(audiences).where(eq(audiences.id, id));
  return row?.status;
}

function campaignSays(entries: Array<Partial<OfferSourceCampaign> & { featureSlug: string }>) {
  vi.mocked(fetchOfferSourceCampaigns).mockResolvedValue(
    entries.map((e) => ({ campaignId: null, status: null, running: false, ...e }))
  );
}

function reconcile() {
  return request(app).post(`/internal/source-campaigns/reconcile?orgId=${ORG}`).set(getAuthHeaders());
}

beforeEach(async () => {
  vi.mocked(createApolloLinkedinEngagementAudience).mockReset().mockImplementation(async (a) => ({
    apolloAudienceId: "33333333-0000-4000-8000-000000000001",
    name: a.name ?? "Engaged with competitor posts",
    description: "People who engaged with a competitor's LinkedIn posts.",
    filters: { buying_signal: { type: "linkedin_engagement", window_days: a.windowDays, competitor_pages: a.competitorPages } },
  }));
  vi.mocked(discoverBrandCompetitors).mockReset().mockResolvedValue({
    status: "computed",
    competitors: [{ name: "lemlist", domain: "lemlist.com", linkedinUrl: PAGES[0] }],
  } as never);
  vi.mocked(fetchOfferSourceCampaigns).mockReset();
  vi.mocked(crmListUploads).mockReset();
  vi.mocked(proposeAudienceSplit).mockReset();
  vi.mocked(createRun).mockClear();
  vi.mocked(getPaymentOutlook).mockReset().mockResolvedValue({ orgId: ORG, state: "will_charge" } as never);
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

describe("push: POST /orgs/source-campaigns/state", () => {
  it("ON with no audience of the list CREATES the LinkedIn engagement audience, active, under the offer, visible in the list", async () => {
    await insertAudience({ name: "Clinic owners" }); // cold filters: another list
    const res = await push({ originSlug: LINKEDIN, status: "on" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "created", listKind: "linkedin_engagement", status: "on", campaignId: LI_CAMPAIGN });
    expect(res.body.audiences).toHaveLength(1);
    expect(res.body.audiences[0].status).toBe("active");

    const list = await request(app).get(`/orgs/audiences?brandId=${BRAND}&offerId=${OFFER}`).set(getAuthHeaders());
    const listed = (list.body.audiences as Array<{ id: string; status: string; channels: Array<{ list: string }> }>).find(
      (a) => a.id === res.body.audiences[0].id
    );
    expect(listed?.status).toBe("active");
    expect(listed?.channels[0]?.list).toBe("linkedin_engagement");

    // The build is billed under its own run labelled with the origin AND the source campaign.
    expect(vi.mocked(createRun)).toHaveBeenCalledWith(
      expect.objectContaining({
        taskName: "source-campaign-audience",
        workflowTracking: expect.objectContaining({ featureSlug: LINKEDIN, campaignId: LI_CAMPAIGN, brandIds: [BRAND] }),
      })
    );
  });

  it("OFF pauses every active audience of THAT list only, and the next ON resumes exactly those", async () => {
    const li = await insertAudience({ name: "Engaged", filters: ENGAGEMENT_FILTERS, source: "linkedin_engagement_signal" });
    const cold = await insertAudience({ name: "Clinic owners" });
    const elsewhere = await insertAudience({ name: "Engaged elsewhere", filters: ENGAGEMENT_FILTERS, offerId: OTHER_OFFER });

    const off = await push({ originSlug: LINKEDIN, status: "off" });
    expect(off.status).toBe(200);
    expect(off.body.outcome).toBe("paused");
    expect(await statusOf(li.id)).toBe("paused");
    expect(await statusOf(cold.id)).toBe("active");
    expect(await statusOf(elsewhere.id)).toBe("active");
    const holds = await db.select().from(sourceCampaignAudienceHolds);
    expect(holds.map((h) => h.audienceId)).toEqual([li.id]);

    const on = await push({ originSlug: LINKEDIN, status: "on" });
    expect(on.body.outcome).toBe("resumed");
    expect(await statusOf(li.id)).toBe("active");
    expect(vi.mocked(createApolloLinkedinEngagementAudience)).not.toHaveBeenCalled();
    const [hold] = await db.select().from(sourceCampaignAudienceHolds);
    expect(hold.releasedAt).not.toBeNull();
  });

  it("ON never revives an audience a PERSON paused while another of the list is active", async () => {
    const live = await insertAudience({ name: "Owners", status: "active" });
    const personPaused = await insertAudience({ name: "Managers", status: "paused" });
    const res = await push({ originSlug: COLD, campaignId: COLD_CAMPAIGN, status: "on" });
    expect(res.body.outcome).toBe("active");
    expect(await statusOf(live.id)).toBe("active");
    expect(await statusOf(personPaused.id)).toBe("paused");
  });

  it("ON is idempotent: a second ON creates nothing", async () => {
    await insertAudience({ name: "Owners" });
    const first = await push({ originSlug: LINKEDIN, status: "on" });
    expect(first.body.outcome).toBe("created");
    const again = await push({ originSlug: LINKEDIN, status: "on" });
    expect(again.body.outcome).toBe("active");
    expect(vi.mocked(createApolloLinkedinEngagementAudience)).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(audiences).where(eq(audiences.source, "linkedin_engagement_signal"));
    expect(rows).toHaveLength(1);
  });

  it("ON of Your CRM Contacts creates one active audience per uploaded file not bound yet", async () => {
    vi.mocked(crmListUploads).mockResolvedValue([
      { id: "up-1", brandId: BRAND, filename: "clients.csv", rowCount: 10, status: "ready" },
      { id: "up-2", brandId: BRAND, filename: "leads.csv", rowCount: 5, status: "ready" },
    ]);
    await insertAudience({ name: "clients", provider: "crm", crmUploadId: "up-1", status: "archived", filters: null });
    const res = await push({ originSlug: CRM, status: "on" });
    expect(res.body.outcome).toBe("created");
    const rows = await db
      .select()
      .from(audiences)
      .where(and(eq(audiences.offerId, OFFER), eq(audiences.status, "active")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "crm", crmUploadId: "up-2", source: "source_campaign" });
  });

  it("ON of Apollo Cold Filters with no cold list builds it from the offer's validated target", async () => {
    await insertAudience({ name: "Engaged", filters: ENGAGEMENT_FILTERS, source: "linkedin_engagement_signal" });
    vi.mocked(proposeAudienceSplit).mockResolvedValue({
      axes: [],
      segments: [{ name: "US clinic owners", description: "Owners of US clinics.", icon: "x", iconConfidence: 1, estimatedLeadCount: null }],
    } as never);
    const res = await push({ originSlug: COLD, campaignId: COLD_CAMPAIGN, status: "on" });
    expect(res.body.outcome).toBe("created");
    expect(vi.mocked(proposeAudienceSplit).mock.calls[0][0]).toBe(TARGET);
    const created = res.body.audiences as Array<{ name: string; status: string }>;
    expect(created).toEqual([expect.objectContaining({ name: "US clinic owners", status: "active" })]);
  });

  it("an origin the catalogue does not name is a 400; an offer with no target says so", async () => {
    const bad = await push({ originSlug: "sourcing-telepathy", status: "on" });
    expect(bad.status).toBe(400);
    const none = await push({ originSlug: LINKEDIN, status: "on" });
    expect(none.status).toBe(200);
    expect(none.body.outcome).toBe("no_target");
    expect(vi.mocked(createApolloLinkedinEngagementAudience)).not.toHaveBeenCalled();
  });
});

describe("reconcile: campaign-service is read, what CHANGED is applied", () => {
  it("first sighting moves nothing that exists (migrated state), later transitions pause and resume", async () => {
    const li = await insertAudience({ name: "Engaged", filters: ENGAGEMENT_FILTERS, source: "linkedin_engagement_signal" });
    const signal = await insertAudience({ name: "Hiring now", filters: SIGNAL_FILTERS });
    const cold = await insertAudience({ name: "Owners" });

    // Mirrored from today: cold filters ON, LinkedIn OFF (row exists), buying signals never created.
    campaignSays([
      { featureSlug: COLD, campaignId: COLD_CAMPAIGN, status: "ongoing", running: true },
      { featureSlug: LINKEDIN, campaignId: LI_CAMPAIGN, status: "stopped", running: false },
      { featureSlug: "sourcing-apollo-buying-signals" },
    ]);
    const first = await reconcile();
    expect(first.status).toBe(200);
    expect(await statusOf(li.id)).toBe("active");
    expect(await statusOf(signal.id)).toBe("active");
    expect(await statusOf(cold.id)).toBe("active");
    const recorded = await db.select().from(sourceCampaignStates);
    expect(recorded.map((r) => `${r.originSlug}:${r.status}:${r.outcome}`).sort()).toEqual([
      `${COLD}:on:active`,
      `${LINKEDIN}:off:recorded`,
    ]);

    // Nothing changed: nothing applied.
    const again = await reconcile();
    expect(again.body.applied).toBe(0);

    // The customer turns LinkedIn ON... then OFF.
    campaignSays([
      { featureSlug: COLD, campaignId: COLD_CAMPAIGN, status: "ongoing", running: true },
      { featureSlug: LINKEDIN, campaignId: LI_CAMPAIGN, status: "ongoing", running: true },
    ]);
    await reconcile();
    expect(await statusOf(li.id)).toBe("active");
    campaignSays([
      { featureSlug: COLD, campaignId: COLD_CAMPAIGN, status: "ongoing", running: true },
      { featureSlug: LINKEDIN, campaignId: LI_CAMPAIGN, status: "stopped", running: false },
    ]);
    const off = await reconcile();
    expect(off.body.entries).toEqual([expect.objectContaining({ originSlug: LINKEDIN, action: "paused", status: "off" })]);
    expect(await statusOf(li.id)).toBe("paused");
    expect(await statusOf(cold.id)).toBe("active");
  });

  it("a source turned ON for the first time on an offer holding none of its list gets its audience", async () => {
    await insertAudience({ name: "Owners" });
    campaignSays([
      { featureSlug: COLD, campaignId: COLD_CAMPAIGN, status: "ongoing", running: true },
      { featureSlug: LINKEDIN, campaignId: LI_CAMPAIGN, status: "ongoing", running: true },
    ]);
    const res = await reconcile();
    expect(res.status).toBe(200);
    const li = res.body.entries.find((e: { originSlug: string }) => e.originSlug === LINKEDIN);
    expect(li).toMatchObject({ action: "created", status: "on" });
    const rows = await db.select().from(audiences).where(eq(audiences.source, "linkedin_engagement_signal"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
  });

  it("a campaign-service read failure is reported per offer, nothing moves", async () => {
    const li = await insertAudience({ name: "Engaged", filters: ENGAGEMENT_FILTERS });
    vi.mocked(fetchOfferSourceCampaigns).mockRejectedValue(new Error("campaign-service down"));
    const res = await reconcile();
    expect(res.body.entries).toEqual([expect.objectContaining({ action: "read_failed", reason: "campaign-service down" })]);
    expect(await statusOf(li.id)).toBe("active");
  });

  it("dryRun reports what would be applied and writes nothing", async () => {
    await insertAudience({ name: "Owners" });
    campaignSays([{ featureSlug: LINKEDIN, campaignId: LI_CAMPAIGN, status: "ongoing", running: true }]);
    const res = await request(app).post(`/internal/source-campaigns/reconcile?orgId=${ORG}&dryRun=true`).set(getAuthHeaders());
    expect(res.body.entries).toEqual([expect.objectContaining({ originSlug: LINKEDIN, action: "would_apply" })]);
    expect(await db.select().from(sourceCampaignStates)).toHaveLength(0);
    expect(vi.mocked(createApolloLinkedinEngagementAudience)).not.toHaveBeenCalled();
  });
});

describe("the competitor-engagement sweep follows the offer's LinkedIn source", () => {
  it("an offer whose sources are campaigns, LinkedIn OFF: the sweep's audience is born PAUSED", async () => {
    await insertAudience({ name: "Owners" });
    await db.insert(sourceCampaignStates).values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      originSlug: COLD,
      listKind: "apollo_search",
      campaignId: COLD_CAMPAIGN,
      status: "on",
    });
    const sweep = await request(app).post(`/internal/competitor-engagement-audiences?brandId=${BRAND}`).set(getAuthHeaders());
    expect(sweep.status).toBe(200);
    const rows = await db.select().from(audiences).where(eq(audiences.source, "linkedin_engagement_signal"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("paused");

    // Turning LinkedIn ON resumes it, nothing left to build.
    const on = await push({ originSlug: LINKEDIN, status: "on" });
    expect(on.body.outcome).toBe("resumed");
    expect(vi.mocked(createApolloLinkedinEngagementAudience)).toHaveBeenCalledTimes(1);
  });

  it("an offer whose sources are not campaigns yet keeps today's rule: born active", async () => {
    await insertAudience({ name: "Owners" });
    await request(app).post(`/internal/competitor-engagement-audiences?brandId=${BRAND}`).set(getAuthHeaders());
    const rows = await db.select().from(audiences).where(eq(audiences.source, "linkedin_engagement_signal"));
    expect(rows[0].status).toBe("active");
  });
});

describe("a first-seen ON of the offer's DEFAULT origin is today's state", () => {
  it("Apollo Cold Filters / Your CRM Contacts first seen ON with no list build NOTHING (no spend nobody asked for)", async () => {
    // An offer whose outreach runs with no live audience (prod 2026-10-07).
    await insertAudience({ name: "Old", status: "archived", provider: "crm", crmUploadId: null, filters: null });
    vi.mocked(crmListUploads).mockResolvedValue([{ id: "up-1", brandId: BRAND, filename: "c.csv", rowCount: 1, status: "ready" }]);
    campaignSays([
      { featureSlug: COLD, campaignId: COLD_CAMPAIGN, status: "ongoing", running: true },
      { featureSlug: CRM, campaignId: "33333333-3333-4333-8333-333333333333", status: "ongoing", running: true },
    ]);
    const res = await reconcile();
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { action: string }) => e.action).sort()).toEqual(["exists_inactive", "recorded"]);
    expect(vi.mocked(proposeAudienceSplit)).not.toHaveBeenCalled();
    expect(vi.mocked(createRun)).not.toHaveBeenCalled();
    const live = await db.select().from(audiences).where(eq(audiences.status, "active"));
    expect(live).toHaveLength(0);
  });
});
