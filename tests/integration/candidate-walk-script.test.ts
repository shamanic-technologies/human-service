// AUDIENCE-SOURCES-1016 (owner 2026-10-16): "the SOURCES should be a concept
// separate from TARGETING". An audience is WHO (one target text); a source is
// WHERE we look (a buying signal, competitor-post engagement), stored beside it
// (audience_sources), never an audience row of its own.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

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
  brandSuppressions,
  candidateWalks,
  audienceCandidates,
  audienceMemberSources,
  audienceMembers,
  audiences,
  audienceScreenedOut,
  audienceSources,
  audienceTeaserBuffer,
  audienceTeaserScreenings,
  leadServes,
  leadSourcingChoices,
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


// FACTORY-P3 next outcomes (lead_found): the stored walk script asks pages of teasers with their facts and hands the
// verdicts back; this service applies them as its own walk does. The "script" below follows the stored script's rules.
const walkSwitch = vi.fn();
const walkWithScript = vi.fn();
vi.mock("../../src/services/candidate-walk.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/candidate-walk.js")>()),
  walkScriptSwitch: (...a: unknown[]) => walkSwitch(...a),
  walkWithScript: (...a: unknown[]) => walkWithScript(...a),
}));
const { walkPageDoor, walkDecideDoor } = await import("../../src/services/audience-candidates.js");

const app = createTestApp();
const ORG = getAuthHeaders()["x-org-id"];
const USER = getAuthHeaders()["x-user-id"];
const BRAND = "00000000-0000-4000-8000-0000000000d1";
const OFFER = "00000000-0000-4000-8000-0000000000e1";
const TARGET = "Chiropractors who own their practice in the US.";
const COLD_FILTERS = { person_titles: ["chiropractor"] };
const fetchSpy = vi.fn();
const fetchBeforeThisSuite = globalThis.fetch;

/** The stored walk's rule: the first free rule a teaser fails (window = 3 calendar months before `now`). */
function verdictOf(t: { lastServedAt: string | null; optedOut: boolean; bounced: boolean; rejected: boolean }, now: string) {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
  if (t.lastServedAt && new Date(t.lastServedAt) > cutoff) return "taken";
  if (t.optedOut) return "opted_out";
  if (t.bounced) return "bounced";
  if (t.rejected) return "rejected";
  return "offer";
}

async function scriptLike(input: { token: string; pageSize: number }) {
  for (let p = 0; p < 50; p++) {
    const page = await walkPageDoor(input.token, input.pageSize);
    if (page.status !== 200) throw new Error(`page: ${String(page.body.error)}`);
    if (page.body.status !== "teasers") return { runId: "walk-run", scriptSlug: "s", candidateId: null };
    const teasers = page.body.teasers as Array<{ ref: string; lastServedAt: string | null; optedOut: boolean; bounced: boolean; rejected: boolean }>;
    const d = await walkDecideDoor(input.token, teasers.map((t) => ({ ref: t.ref, verdict: verdictOf(t, String(page.body.now)) })));
    if (d.status !== 200) throw new Error(`decide: ${String(d.body.error)}`);
    const offered = d.body.offered as { candidateId: string } | null;
    if (offered) return { runId: "walk-run", scriptSlug: "s", candidateId: offered.candidateId };
  }
  return { runId: "walk-run", scriptSlug: "s", candidateId: null };
}

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  vi.mocked(getPaymentOutlook).mockReset().mockResolvedValue({ orgId: ORG, state: "will_charge" } as never);
  walkSwitch.mockReset().mockResolvedValue({ switched: true, dynasty: "dy_walk_pages" });
  walkWithScript.mockReset().mockImplementation(scriptLike);
  await cleanTestData();
  await db.delete(candidateWalks);
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


/** Teasers already in the buffer, oldest first (a person served or rejected AFTER they were buffered). */
async function bufferAll(audienceId: string, ids: string[]) {
  const t0 = Date.now() - 60_000;
  await db.insert(audienceTeaserBuffer).values(
    ids.map((id, i) => ({ orgId: ORG, audienceId, providerPersonId: id, linkedinUrl: `linkedin.com/in/${id}`, teaser: { organizationName: `Clinic ${id}` } as never, organizationDomain: `${id}.example`, createdAt: new Date(t0 + i * 1000) }))
  );
}

describe("the stored walk walks our teasers through its doors", () => {
  it("skips a person the brand served last month and one rejected here, offers the next, and puts the page's rest back where it was", async () => {
    let searches = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/search/next")) {
        searches++;
        const people: unknown[] = [];
        return ok({ people, done: people.length === 0, totalEntries: people.length });
      }
      throw new Error("unexpected url " + url);
    });
    const audience = await insertAudience({ name: "Chiro owners" });
    await bufferAll(audience.id, ["p0", "p1", "p2", "p3"]);
    await db.insert(brandSuppressions).values({ orgId: ORG, brandId: BRAND, emailNorm: "p0@x.com", providerPersonId: "p0", lastServedAt: new Date(Date.now() - 30 * 86_400_000) });
    await db.insert(audienceScreenedOut).values({ orgId: ORG, audienceId: audience.id, providerPersonId: "p1", reason: "screen" });

    const res = await request(app)
      .post(`/orgs/audiences/${audience.id}/candidates/next`)
      .set({ ...getAuthHeaders(), "x-run-id": "11111111-1111-4111-8111-111111111111", "x-feature-slug": "sourcing-apollo-cold-filters" })
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("candidate");
    expect(res.body.candidate.providerPersonId).toBe("p2");
    expect(walkWithScript).toHaveBeenCalledWith(expect.objectContaining({ dynasty: "dy_walk_pages", pageSize: 20, window: "3_months" }));
    // p3 was popped in the page and not decided: back in the buffer.
    const buffered = await db.select().from(audienceTeaserBuffer).where(eq(audienceTeaserBuffer.audienceId, audience.id));
    expect(buffered.map((b) => b.providerPersonId)).toEqual(["p3"]);
    // The page took only what the buffer held: no search, no exhaustion stated before the offer.
    expect(fetchSpy).not.toHaveBeenCalled();
    // p0 (taken) is tagged as found by this audience, as our own walk does.
    const members = await db.select().from(audienceMembers).where(eq(audienceMembers.audienceId, audience.id));
    expect(members).toHaveLength(1);
    // The walk is recorded in the script's words.
    const [walk] = await db.select().from(candidateWalks);
    expect(walk).toMatchObject({ path: "script", status: "candidate", runId: "walk-run" });
    expect((walk!.calls as Array<{ name: string }>).map((c) => c.name)).toEqual(["human.walk.page", "human.walk.decide"]);
  });

  it("a door serves only a walk in flight", async () => {
    expect((await walkPageDoor("nope", 20)).status).toBe(409);
    expect((await walkDecideDoor("nope", [])).status).toBe(409);
  });

  it("our own walk (not switched) offers the same person, and its record replays to the same verdicts", async () => {
    walkSwitch.mockResolvedValue({ switched: false, dynasty: null });
    vi.spyOn(Math, "random").mockReturnValue(0);
    let searches = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/search/next")) {
        searches++;
        const people: unknown[] = [];
        return ok({ people, done: people.length === 0, totalEntries: people.length });
      }
      throw new Error("unexpected url " + url);
    });
    const audience = await insertAudience({ name: "Chiro owners" });
    await bufferAll(audience.id, ["p0", "p1", "p2", "p3"]);
    await db.insert(brandSuppressions).values({ orgId: ORG, brandId: BRAND, emailNorm: "p0@x.com", providerPersonId: "p0", lastServedAt: new Date(Date.now() - 30 * 86_400_000) });
    await db.insert(audienceScreenedOut).values({ orgId: ORG, audienceId: audience.id, providerPersonId: "p1", reason: "screen" });
    const res = await request(app).post(`/orgs/audiences/${audience.id}/candidates/next`).set({ ...getAuthHeaders(), "x-feature-slug": "sourcing-apollo-cold-filters" }).send({});
    expect(res.body.candidate.providerPersonId).toBe("p2");
    const [walk] = await db.select().from(candidateWalks);
    expect(walk).toMatchObject({ path: "service", status: "candidate", units: { window: "3_months", pageSize: 1 } });
    const calls = walk!.calls as Array<{ name: string; args: Record<string, unknown>; answer: { data: Record<string, unknown> } }>;
    const verdicts = calls.filter((c) => c.name === "human.walk.decide").map((c) => (c.args.verdicts as Array<{ verdict: string }>)[0]!.verdict);
    expect(verdicts).toEqual(["taken", "rejected", "offer"]);
    // Each recorded page's facts give the same verdict under the script's rule.
    const pages = calls.filter((c) => c.name === "human.walk.page").map((c) => c.answer.data);
    expect(pages.map((p) => verdictOf((p.teasers as never[])[0]!, String(p.now)))).toEqual(verdicts);
    vi.restoreAllMocks();
  });
});
