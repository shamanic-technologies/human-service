// AUDIENCE-SOURCES-1016 (owner 2026-10-16): "the SOURCES should be a concept
// separate from TARGETING". An audience is WHO (one target text); a source is
// WHERE we look (a buying signal, competitor-post engagement), stored beside it
// (audience_sources), never an audience row of its own.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../../src/lib/email-verification.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readEmailVerification: (_p: string, _r: unknown, email: string | null | undefined) =>
    email ? { verdict: "valid", deliverable: true } : null,
}));
import request from "supertest";
import { and, eq, isNotNull } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  audienceCandidates,
  audienceMemberSources,
  audienceMembers,
  audiences,
  audienceScreenedOut,
  audienceSources,
  audienceTeaserBuffer,
  audienceTeaserScreenings,
  leadServes,
  people,
  sourceCampaignStates,
} from "../../src/db/schema.js";
import {
  createApolloLinkedinEngagementAudience,
  createApolloSignalAudience,
  measureSignalCoverage,
} from "../../src/lib/apollo-audiences.js";
import { discoverBrandCompetitors } from "../../src/lib/brand-competitors.js";
import { getPaymentOutlook } from "../../src/lib/billing-outlook.js";

vi.mock("../../src/lib/apollo-audiences.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/apollo-audiences.js")>()),
  createApolloLinkedinEngagementAudience: vi.fn(),
  measureSignalCoverage: vi.fn(),
  createApolloSignalAudience: vi.fn(),
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
vi.mock("../../src/services/audience-refill.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-refill.js")>()),
  runAudienceRefillSweep: vi.fn(async () => ({})),
}));
vi.mock("../../src/lib/lead-won.js", () => ({
  listWonEmails: vi.fn(async () => []),
  isEmailWon: vi.fn(async () => false),
  WonLeadsSourceError: class WonLeadsSourceError extends Error {},
  WonLeadsConfigError: class WonLeadsConfigError extends Error {},
}));
vi.mock("../../src/services/bounces.js", () => ({
  filterBounced: vi.fn(async (_identity: unknown, items: unknown[]) => items),
  isEmailBounced: vi.fn(async () => false),
}));
vi.mock("../../src/lib/instantly-optouts.js", () => ({
  listStandingOptOutEmails: vi.fn(async () => []),
  isEmailOptedOut: vi.fn(async () => false),
  OptOutSourceError: class OptOutSourceError extends Error {},
  OptOutConfigError: class OptOutConfigError extends Error {},
}));

const app = createTestApp();
const ORG = getAuthHeaders()["x-org-id"];
const USER = getAuthHeaders()["x-user-id"];
const BRAND = "00000000-0000-4000-8000-0000000000d1";
const OFFER = "00000000-0000-4000-8000-0000000000e1";
const COLD = "sourcing-apollo-cold-filters";
const SIGNALS = "sourcing-apollo-buying-signals";
const LINKEDIN = "sourcing-linkedin-engagement-signals";
const TARGET = "Chiropractors who own their practice in the US.";
const PAGES = ["https://www.linkedin.com/company/chirocandy/"];
const COLD_FILTERS = { person_titles: ["chiropractor"] };
const HIRING_FILTERS = { person_titles: ["chiropractor"], buying_signal: { type: "hiring", window_days: 30 } };
const ENGAGEMENT_FILTERS = { buying_signal: { type: "linkedin_engagement", window_days: 30, competitor_pages: PAGES } };

const fetchSpy = vi.fn();
const fetchBeforeThisSuite = globalThis.fetch;

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  vi.mocked(createApolloLinkedinEngagementAudience).mockReset().mockImplementation(async (a) => ({
    apolloAudienceId: "33333333-0000-4000-8000-000000000001",
    name: a.name ?? "Engaged",
    description: "Engagers",
    filters: { buying_signal: { type: "linkedin_engagement", window_days: a.windowDays, competitor_pages: a.competitorPages } },
  }));
  vi.mocked(discoverBrandCompetitors).mockReset().mockResolvedValue({
    status: "computed",
    competitors: [{ name: "ChiroCandy", domain: "chirocandy.com", linkedinUrl: PAGES[0] }],
  } as never);
  vi.mocked(measureSignalCoverage).mockReset().mockResolvedValue({
    baseCount: 5000,
    signals: (["hiring", "job_change", "funding"] as const).flatMap((type) =>
      [30, 90].map((windowDays) => ({ type, windowDays, count: 300, companies: type === "funding" ? 4 : 80, companiesExact: true }))
    ),
  });
  vi.mocked(createApolloSignalAudience).mockReset().mockImplementation(async (a) => ({
    apolloAudienceId: `${a.baseApolloAudienceId}-${a.type}`,
    filters: { person_titles: ["chiropractor"], buying_signal: { type: a.type, window_days: a.windowDays } },
    count: 300,
  }));
  vi.mocked(getPaymentOutlook).mockReset().mockResolvedValue({ orgId: ORG, state: "will_charge" } as never);
  await cleanTestData();
});

afterAll(async () => {
  globalThis.fetch = fetchBeforeThisSuite;
  await closeDb();
});

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

function teaser(id: string) {
  return {
    id,
    firstName: "C",
    lastName: null,
    name: null,
    email: null,
    emailStatus: null,
    title: `Chiropractor ${id}`,
    headline: null,
    seniority: "owner",
    linkedinUrl: `linkedin.com/in/${id}`,
    photoUrl: null,
    city: "Austin",
    state: null,
    country: "United States",
    organizationName: `Clinic ${id}`,
    organizationDomain: `${id}.example`,
    organizationWebsiteUrl: null,
    organizationIndustry: "health",
    organizationSize: null,
    organizationLinkedinUrl: null,
    organizationLogoUrl: null,
    organizationCity: null,
    organizationState: null,
    organizationCountry: null,
  };
}

// Apollo answers by WHICH filters it is asked: the cold filters find `cold-*`, the
// hiring filters find `hiring-*`. Every screen passes.
function mockApollo() {
  const searched: string[] = [];
  const served = { cold: 0, hiring: 0 };
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/search/next")) {
      const body = JSON.parse(init.body ?? "{}") as { searchParams?: Record<string, unknown> };
      const kind = body.searchParams?.buying_signal ? "hiring" : "cold";
      searched.push(kind);
      const n = served[kind]++;
      const people = n < 2 ? [teaser(`${kind}-${n}`)] : [];
      return ok({ people, done: people.length === 0, totalEntries: people.length });
    }
    if (u.endsWith("/enrich")) {
      const id = (JSON.parse(init.body ?? "{}") as { apolloPersonId: string }).apolloPersonId;
      return ok({ person: { ...teaser(id), lastName: "D", name: "C D", email: `${id}@x.com`, emailStatus: "verified" } });
    }
    if (u.endsWith("/orgs/judgments")) {
      return ok({ model: "jev-1.13.0", answers: { answer: { type: "noul", noul: 0.9 } } });
    }
    throw new Error("unexpected url " + u);
  });
  return { searched };
}

async function insertAudience(v: {
  name: string;
  status?: string;
  filters?: unknown;
  profileAudienceId?: string | null;
  source?: string | null;
  statusSetBy?: string | null;
  statusSetReason?: string | null;
}) {
  const [row] = await db
    .insert(audiences)
    .values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      name: v.name,
      nlPrompt: TARGET,
      targetText: TARGET,
      targetTextOrigin: "audience_target",
      provider: "apollo",
      apolloAudienceId: `apollo-${v.name}`,
      filters: (v.filters ?? COLD_FILTERS) as never,
      apolloCount: 1000,
      countedAt: new Date(),
      status: v.status ?? "active",
      statusSetBy: v.statusSetBy ?? null,
      statusSetReason: v.statusSetReason ?? null,
      source: v.source ?? null,
      profileAudienceId: v.profileAudienceId ?? null,
      createdByUserId: USER,
    })
    .returning();
  return row;
}

async function addHiringSource(audienceId: string, status = "active") {
  const [s] = await db
    .insert(audienceSources)
    .values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      audienceId,
      list: "apollo_buying_signal",
      signalType: "hiring",
      windowDays: 30,
      name: "Hiring now",
      apolloAudienceId: "apollo-hiring",
      filters: HIRING_FILTERS,
      apolloCount: 300,
      status,
    })
    .returning();
  return s;
}

function serve(id: string, slug: string) {
  return request(app)
    .post(`/orgs/audiences/${id}/serve-next`)
    .set({ ...getAuthHeaders(), "x-feature-slug": slug })
    .send({});
}

function nextCandidate(id: string, slug: string) {
  return request(app)
    .post(`/orgs/audiences/${id}/candidates/next`)
    .set({ ...getAuthHeaders(), "x-feature-slug": slug })
    .send({});
}

async function activeAudiences() {
  const res = await request(app).get(`/orgs/audiences?brandId=${BRAND}&offerId=${OFFER}&status=active`).set(getAuthHeaders());
  expect(res.status).toBe(200);
  return res.body.audiences as Array<{ id: string; name: string; channels: Array<Record<string, unknown>> }>;
}

describe("serving: the slug names the source", () => {
  it("serve-next serves a hiring teaser under the buying-signal slug, a cold one under the cold slug, and records the source", async () => {
    const { searched } = mockApollo();
    const target = await insertAudience({ name: "Chiro owners" });
    const hiring = await addHiringSource(target.id);

    const sig = await serve(target.id, SIGNALS);
    expect(sig.status).toBe(200);
    expect(sig.body.status).toBe("served");
    expect(sig.body.person.providerPersonId).toBe("hiring-0");
    const cold = await serve(target.id, COLD);
    expect(cold.body.status).toBe("served");
    expect(cold.body.person.providerPersonId).toBe("cold-0");
    expect(searched).toEqual(["hiring", "cold"]);

    const serves = await db.select().from(leadServes).where(eq(leadServes.audienceId, target.id));
    const bySource = Object.fromEntries(serves.map((s) => [s.providerPersonId, s.audienceSourceId]));
    expect(bySource).toEqual({ "hiring-0": hiring.id, "cold-0": null });
    const screenings = await db.select().from(audienceTeaserScreenings).where(eq(audienceTeaserScreenings.audienceId, target.id));
    expect(Object.fromEntries(screenings.map((s) => [s.providerPersonId, s.sourceId]))).toEqual({ "hiring-0": hiring.id, "cold-0": null });
    // Screened against the AUDIENCE's own text, both sources.
    expect(new Set(screenings.map((s) => s.targetText))).toEqual(new Set([TARGET]));
    // Per-source provenance, one query.
    const found = await db.select().from(audienceMemberSources).where(eq(audienceMemberSources.sourceId, hiring.id));
    expect(found).toHaveLength(1);
    // Membership stays the audience's: both people are its members.
    const members = await db.select().from(audienceMembers).where(eq(audienceMembers.audienceId, target.id));
    expect(members).toHaveLength(2);
  });

  it("candidates/next offers from the slug's source and the reveal records it", async () => {
    mockApollo();
    const target = await insertAudience({ name: "Chiro owners" });
    const hiring = await addHiringSource(target.id);

    const next = await nextCandidate(target.id, SIGNALS);
    expect(next.status).toBe(200);
    expect(next.body.status).toBe("candidate");
    expect(next.body.candidate.providerPersonId).toBe("hiring-0");
    expect(next.body.candidate.sourceId).toBe(hiring.id);
    const [row] = await db.select().from(audienceCandidates).where(eq(audienceCandidates.id, next.body.candidate.candidateId));
    expect(row.sourceId).toBe(hiring.id);

    const reveal = await request(app)
      .post(`/orgs/audiences/${target.id}/candidates/${next.body.candidate.candidateId}/reveal`)
      .set({ ...getAuthHeaders(), "x-feature-slug": SIGNALS })
      .send({});
    expect(reveal.body.status).toBe("served");
    const [serve1] = await db.select().from(leadServes).where(eq(leadServes.providerPersonId, "hiring-0"));
    expect(serve1.audienceSourceId).toBe(hiring.id);

    const coldNext = await nextCandidate(target.id, COLD);
    expect(coldNext.body.candidate.providerPersonId).toBe("cold-0");
    expect(coldNext.body.candidate.sourceId).toBeNull();
  });

  it("an OFF source serves nothing; an audience with no source serves exactly as before under any slug", async () => {
    const { searched } = mockApollo();
    const target = await insertAudience({ name: "Chiro owners" });
    await addHiringSource(target.id, "paused");
    const off = await serve(target.id, SIGNALS);
    expect(off.body).toEqual({ status: "exhausted", person: null });
    expect(searched).toEqual([]);

    const plain = await insertAudience({ name: "Employed chiros" });
    const res = await serve(plain.id, SIGNALS);
    expect(res.body.status).toBe("served");
    expect(searched).toEqual(["cold"]);
  });

  it("a source of a PAUSED audience serves nobody", async () => {
    const { searched } = mockApollo();
    const target = await insertAudience({ name: "Chiro owners", status: "paused", statusSetBy: "person" });
    await addHiringSource(target.id);
    expect((await serve(target.id, SIGNALS)).body.status).toBe("exhausted");
    expect(searched).toEqual([]);
  });
});

describe("GET /orgs/audiences/{id}/sourcing-origin", () => {
  function origin(id: string) {
    return request(app)
      .get(`/orgs/audiences/${id}/sourcing-origin`)
      .set({ ...getAuthHeaders(), "x-feature-slug": "sales-cold-email-outreach" });
  }

  it("answers one of the audience's ON sources, never an OFF one", async () => {
    const target = await insertAudience({ name: "Chiro owners" });
    const hiring = await addHiringSource(target.id);
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) seen.add((await origin(target.id)).body.sourcingFeatureSlug);
    expect(seen).toEqual(new Set([COLD, SIGNALS]));

    await db.update(audienceSources).set({ status: "paused" }).where(eq(audienceSources.id, hiring.id));
    const after = new Set<string>();
    for (let i = 0; i < 10; i++) after.add((await origin(target.id)).body.sourcingFeatureSlug);
    expect(after).toEqual(new Set([COLD]));

    await db.update(audiences).set({ ownSourceStatus: "paused" }).where(eq(audiences.id, target.id));
    await db.update(audienceSources).set({ status: "active" }).where(eq(audienceSources.id, hiring.id));
    for (let i = 0; i < 10; i++) expect((await origin(target.id)).body.sourcingFeatureSlug).toBe(SIGNALS);
  });

  it("asked with NO slug it answers the audience's OWN list, always (which source campaign it belongs to)", async () => {
    const target = await insertAudience({ name: "Chiro owners" });
    await addHiringSource(target.id);
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get(`/orgs/audiences/${target.id}/sourcing-origin`).set(getAuthHeaders());
      expect(res.body.sourcingFeatureSlug).toBe(COLD);
    }
  });

  it("asked with an ORIGIN slug it answers that origin when the audience finds people through it, else its own list", async () => {
    const target = await insertAudience({ name: "Chiro owners" });
    await addHiringSource(target.id, "paused");
    const ask = (slug: string) =>
      request(app).get(`/orgs/audiences/${target.id}/sourcing-origin`).set({ ...getAuthHeaders(), "x-feature-slug": slug });
    expect((await ask(SIGNALS)).body.sourcingFeatureSlug).toBe(SIGNALS);
    expect((await ask(COLD)).body.sourcingFeatureSlug).toBe(COLD);
    expect((await ask(LINKEDIN)).body.sourcingFeatureSlug).toBe(COLD);
  });

  it("an audience with no source answers its own list (unchanged)", async () => {
    const target = await insertAudience({ name: "Chiro owners" });
    expect((await origin(target.id)).body).toEqual({ audienceId: target.id, list: "apollo_search", sourcingFeatureSlug: COLD });
  });
});

describe("building sources: never an audience row per source", () => {
  it("a buying-signal source campaign ON adds sources to each profile, zero '<x> (<source>)' rows, listed in channels[]", async () => {
    const owners = await insertAudience({ name: "Chiro owners" });
    const employed = await insertAudience({ name: "Employed chiros" });
    const res = await request(app)
      .post("/orgs/source-campaigns/state")
      .set(getAuthHeaders())
      .send({ brandId: BRAND, offerId: OFFER, campaignId: "11111111-1111-4111-8111-111111111111", originSlug: SIGNALS, status: "on" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("created");

    const rows = await db.select().from(audiences).where(eq(audiences.brandId, BRAND));
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => / \(.+\)$/.test(r.name))).toBe(false);
    const listed = await activeAudiences();
    expect(listed.map((a) => a.id).sort()).toEqual([owners.id, employed.id].sort());
    for (const a of listed) {
      // own list + hiring + job_change (funding below the 20-company threshold)
      expect(a.channels.map((c) => [c.list, (c.signal as { type: string } | null)?.type ?? null])).toEqual([
        ["apollo_search", null],
        ["apollo_buying_signal", "hiring"],
        ["apollo_buying_signal", "job_change"],
      ]);
      expect(a.channels[1]).toMatchObject({ audienceId: a.id, name: "Hiring now", status: "active", size: 300 });
    }

    // OFF pauses the sources, the audiences keep running through their own list.
    const off = await request(app)
      .post("/orgs/source-campaigns/state")
      .set(getAuthHeaders())
      .send({ brandId: BRAND, offerId: OFFER, campaignId: "11111111-1111-4111-8111-111111111111", originSlug: SIGNALS, status: "off" });
    expect(off.body.outcome).toBe("paused");
    const sources = await db.select().from(audienceSources);
    expect(new Set(sources.map((s) => s.status))).toEqual(new Set(["paused"]));
    expect((await activeAudiences()).length).toBe(2);
  });

  it("cold filters OFF keeps an audience running through its ON source; its last source OFF pauses it; ON resumes it", async () => {
    const target = await insertAudience({ name: "Chiro owners" });
    await addHiringSource(target.id);
    const send = (originSlug: string, status: string) =>
      request(app)
        .post("/orgs/source-campaigns/state")
        .set(getAuthHeaders())
        .send({ brandId: BRAND, offerId: OFFER, campaignId: "22222222-2222-4222-8222-222222222222", originSlug, status });

    await send(COLD, "off");
    let [row] = await db.select().from(audiences).where(eq(audiences.id, target.id));
    expect(row).toMatchObject({ status: "active", ownSourceStatus: "paused" });

    await send(SIGNALS, "off");
    [row] = await db.select().from(audiences).where(eq(audiences.id, target.id));
    expect(row.status).toBe("paused");

    await send(SIGNALS, "on");
    [row] = await db.select().from(audiences).where(eq(audiences.id, target.id));
    expect(row).toMatchObject({ status: "active", ownSourceStatus: "paused" });

    await send(COLD, "on");
    [row] = await db.select().from(audiences).where(eq(audiences.id, target.id));
    expect(row).toMatchObject({ status: "active", ownSourceStatus: "active" });
  });

  it("an OFF never resumes, and an ON never resumes, an audience a PERSON paused", async () => {
    const target = await insertAudience({ name: "Chiro owners", status: "paused", statusSetBy: "person", statusSetReason: "person" });
    await addHiringSource(target.id, "paused");
    await request(app)
      .post("/orgs/source-campaigns/state")
      .set(getAuthHeaders())
      .send({ brandId: BRAND, offerId: OFFER, campaignId: "11111111-1111-4111-8111-111111111111", originSlug: SIGNALS, status: "on" });
    const [row] = await db.select().from(audiences).where(eq(audiences.id, target.id));
    expect(row.status).toBe("paused");
  });

  it("the competitor-engagement sweep adds an engagement SOURCE to each profile, no new audience", async () => {
    const owners = await insertAudience({ name: "Chiro owners" });
    const res = await request(app).post(`/internal/competitor-engagement-audiences?brandId=${BRAND}`).set(getAuthHeaders());
    expect(res.status).toBe(200);
    const rows = await db.select().from(audiences).where(eq(audiences.brandId, BRAND));
    expect(rows.map((r) => r.id)).toEqual([owners.id]);
    const sources = await db.select().from(audienceSources).where(eq(audienceSources.list, "linkedin_engagement"));
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ audienceId: owners.id, name: "Engaged with competitor posts", status: "active" });
    const [listed] = await activeAudiences();
    expect(listed.channels.map((c) => c.list)).toContain("linkedin_engagement");
  });
});

describe("POST /internal/merge-source-audiences (one-time, reversible)", () => {
  // Shaped like Doc Dinners: 1 target + 2 signal children + 1 engagement child.
  async function docDinnersShape() {
    const target = await insertAudience({ name: "Chiro owners" });
    const hiring = await insertAudience({ name: "Chiro owners (Hiring now)", filters: HIRING_FILTERS, profileAudienceId: target.id, source: "icp_portfolio_signal" });
    const jobChange = await insertAudience({
      name: "Chiro owners (New in role)",
      filters: { person_titles: ["chiropractor"], buying_signal: { type: "job_change", window_days: 90 } },
      profileAudienceId: target.id,
      source: "icp_portfolio_signal",
      status: "paused",
      statusSetBy: "system",
      statusSetReason: "source_campaign_off",
    });
    const engaged = await insertAudience({
      name: "Chiro owners (Engaged with competitor posts)",
      filters: ENGAGEMENT_FILTERS,
      profileAudienceId: target.id,
      source: "linkedin_engagement_signal",
    });
    // A person served under the old hiring row, with a buffered teaser and a rejection.
    const [person] = await db.insert(people).values({ orgId: ORG, emailNorm: "ann@clinic.com", fullName: "Ann" }).returning();
    await db.insert(audienceMembers).values({ orgId: ORG, audienceId: hiring.id, personId: person.id, source: "apollo" });
    await db.insert(audienceTeaserBuffer).values({ orgId: ORG, audienceId: hiring.id, providerPersonId: "buffered-1" });
    await db.insert(audienceScreenedOut).values({ orgId: ORG, audienceId: hiring.id, providerPersonId: "rejected-1", reason: "P(yes)=0.1" });
    return { target, hiring, jobChange, engaged, person };
  }

  const merge = (q = "") => request(app).post(`/internal/merge-source-audiences?brandId=${BRAND}${q}`).set(getAuthHeaders());

  it("dry run reports 3 moves and 0 archives, writes nothing", async () => {
    const { target } = await docDinnersShape();
    const dry = await merge("&dryRun=true");
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, scanned: 3, moved: 3, archived: 0, skipped: [] });
    expect(dry.body.moves.map((m: { targetAudienceId: string }) => m.targetAudienceId)).toEqual([target.id, target.id, target.id]);
    expect(await db.select().from(audienceSources)).toHaveLength(0);
    expect((await db.select().from(audiences).where(eq(audiences.status, "deprecated"))).length).toBe(0);
  });

  it("real run: 1 active audience with 4 sources, old rows deprecated -> target; reads resolve to the target; re-run moves 0; revert restores", async () => {
    const { target, hiring, jobChange, engaged, person } = await docDinnersShape();
    const run = await merge();
    expect(run.body).toMatchObject({ dryRun: false, moved: 3, archived: 0 });

    const listed = await activeAudiences();
    expect(listed.map((a) => a.id)).toEqual([target.id]);
    expect(listed[0].channels.map((c) => c.list)).toEqual([
      "apollo_search",
      "apollo_buying_signal",
      "apollo_buying_signal",
      "linkedin_engagement",
    ]);
    const sources = await db.select().from(audienceSources).where(eq(audienceSources.audienceId, target.id));
    expect(Object.fromEntries(sources.map((s) => [s.signalType ?? s.list, s.status]))).toEqual({
      hiring: "active",
      job_change: "paused",
      linkedin_engagement: "active",
    });
    const old = await db.select().from(audiences).where(eq(audiences.status, "deprecated"));
    expect(old.map((r) => r.id).sort()).toEqual([hiring.id, jobChange.id, engaged.id].sort());
    expect(new Set(old.map((r) => r.canonicalAudienceId))).toEqual(new Set([target.id]));
    // Nothing archived, nothing deleted.
    expect((await db.select().from(audiences).where(eq(audiences.status, "archived"))).length).toBe(0);
    expect((await db.select().from(audiences)).length).toBe(4);
    // Buffer moved under the source; rejection copied to the target.
    const hiringSource = sources.find((s) => s.signalType === "hiring")!;
    const [buffered] = await db.select().from(audienceTeaserBuffer);
    expect(buffered).toMatchObject({ audienceId: target.id, sourceId: hiringSource.id });
    const rejected = await db.select().from(audienceScreenedOut).where(eq(audienceScreenedOut.audienceId, target.id));
    expect(rejected).toHaveLength(1);

    // Reads on a person served under the old child row answer the target.
    const stats = await request(app).post("/orgs/audiences/stats").set(getAuthHeaders()).send({ emails: ["ann@clinic.com"] });
    expect(stats.body.matched[0].audiences.map((a: { audienceId: string }) => a.audienceId)).toEqual([target.id]);
    const members = await request(app).get(`/orgs/audiences/${target.id}/members`).set(getAuthHeaders());
    expect(members.body.members.map((m: { personId: string }) => m.personId)).toEqual([person.id]);
    expect(members.body.total).toBe(1);
    const resolved = await request(app)
      .post("/internal/audiences/resolve")
      .set(getAuthHeaders())
      .send({ orgId: ORG, brandId: BRAND, emails: ["ann@clinic.com"] });
    expect(resolved.body.byEmail["ann@clinic.com"].id).toBe(target.id);

    // Idempotent.
    const again = await merge();
    expect(again.body.moved).toBe(0);

    // Revert: back exactly as before.
    const revert = await request(app).post(`/internal/merge-source-audiences/revert?brandId=${BRAND}`).set(getAuthHeaders());
    expect(revert.body.reverted).toBe(3);
    expect(await db.select().from(audienceSources)).toHaveLength(0);
    const back = await db.select().from(audiences).where(isNotNull(audiences.profileAudienceId));
    expect(Object.fromEntries(back.map((r) => [r.id, r.status]))).toEqual({
      [hiring.id]: "active",
      [jobChange.id]: "paused",
      [engaged.id]: "active",
    });
    expect(back.every((r) => r.canonicalAudienceId === null)).toBe(true);
    const [bufferBack] = await db.select().from(audienceTeaserBuffer);
    expect(bufferBack).toMatchObject({ audienceId: hiring.id, sourceId: null });
    expect(await db.select().from(audienceScreenedOut).where(eq(audienceScreenedOut.audienceId, target.id))).toHaveLength(0);
  });

  it("a profile paused by its cold source campaign OFF while a child ran keeps running through the merged source", async () => {
    const target = await insertAudience({ name: "Chiro owners", status: "paused", statusSetBy: "system", statusSetReason: "source_campaign_off" });
    await db.update(audiences).set({ ownSourceStatus: "paused" }).where(eq(audiences.id, target.id));
    await insertAudience({ name: "Chiro owners (Hiring now)", filters: HIRING_FILTERS, profileAudienceId: target.id });
    await merge();
    const [row] = await db.select().from(audiences).where(eq(audiences.id, target.id));
    expect(row).toMatchObject({ status: "active", ownSourceStatus: "paused" });
    await request(app).post(`/internal/merge-source-audiences/revert?brandId=${BRAND}`).set(getAuthHeaders());
    const [back] = await db.select().from(audiences).where(eq(audiences.id, target.id));
    expect(back.status).toBe("paused");
  });

  it("leaves source campaign states and hand-made targets untouched", async () => {
    await insertAudience({ name: "US chiros", statusSetBy: "person" });
    await db.insert(sourceCampaignStates).values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      originSlug: LINKEDIN,
      listKind: "linkedin_engagement",
      status: "on",
      outcome: "active",
    });
    const run = await merge();
    expect(run.body).toMatchObject({ scanned: 0, moved: 0 });
    const rows = await db.select().from(audiences).where(and(eq(audiences.brandId, BRAND), eq(audiences.status, "active")));
    expect(rows).toHaveLength(1);
  });
});
