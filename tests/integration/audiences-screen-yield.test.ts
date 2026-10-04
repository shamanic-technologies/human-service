import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// The provider's verdict on a revealed email (apollo-service emailVerification)
// is its own suite's concern; here every revealed address reads as deliverable.
vi.mock("../../src/lib/email-verification.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readEmailVerification: (_p: string, _r: unknown, email: string | null | undefined) =>
    email ? { verdict: "valid", deliverable: true } : null,
}));
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  SCREEN_PROMPT_VERSION,
  SCREEN_YIELD_WINDOW,
  screenBarTag,
} from "../../src/services/teaser-screening.js";
import { screenTarget } from "../../src/services/audience-target-text.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  audiences,
  audienceScreenedOut,
  audienceTeaserBuffer,
  audienceTeaserScreenings,
} from "../../src/db/schema.js";

// The refill sweep has its own suites; here we only check it is ASKED for the brand.
const refillSweep = vi.fn(async (_opts: { brandId?: string }) => null);
vi.mock("../../src/services/audience-refill.js", () => ({
  runAudienceRefillSweep: (opts: { brandId?: string }) => refillSweep(opts),
}));

// The serve path reads the org's consent log from instantly-service on every
// serve. That gate has its own suite (opt-outs.test.ts / audiences-opt-out.test.ts);
// here it is stubbed to an empty log so these tests stay about their own subject.
// Same for the brand's won people (lead-service) — stubbed to an empty set.
vi.mock("../../src/lib/lead-won.js", () => ({
  listWonEmails: vi.fn(async () => []),
  isEmailWon: vi.fn(async () => false),
  WonLeadsSourceError: class WonLeadsSourceError extends Error {},
  WonLeadsConfigError: class WonLeadsConfigError extends Error {},
}));
// The fleet-wide hard-bounce gate has its own suite (bounces.test.ts /
// audiences-bounce.test.ts); here it is a no-op.
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


// The pre-pay screen: an apollo free teaser is judged (Jev, yes-probability > 0.50)
// against the customer's own words (nl_prompt) BEFORE the credit that reveals its
// email is spent. The point of
// every test here is the SPEND — a rejected teaser must never reach /enrich.

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000b1";

const fetchSpy = vi.fn();
// Stub fetch in beforeEach (not at describe-body eval, which would clobber the
// other files' provider mocks at collection time), and hand the global BACK on
// the way out — this suite runs with one shared global, so a stub left installed
// silently disables whichever file's mock was there before ours.
const fetchBeforeThisSuite = globalThis.fetch;

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  refillSweep.mockClear();
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  await cleanTestData();
});

afterAll(async () => {
  globalThis.fetch = fetchBeforeThisSuite;
  await closeDb();
});

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

function teaser(id: string, title: string) {
  return {
    id,
    firstName: "C",
    lastName: null,
    name: null,
    email: null,
    emailStatus: null,
    title,
    headline: null,
    seniority: "owner",
    linkedinUrl: `linkedin.com/in/${id}`,
    photoUrl: null,
    city: "Zurich",
    state: null,
    country: "Switzerland",
    organizationName: "Acme",
    organizationDomain: "acme.com",
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

function revealed(id: string, email: string) {
  return { ...teaser(id, "Chiropractor"), lastName: "D", name: "C D", email, emailStatus: "verified" };
}

// The screen judges against `nlPrompt` (the customer's words). `description` is
// set too, to prove the screen never falls back to it.
async function createDescribedAudience(
  name: string,
  nlPrompt: string | null,
  apolloCount?: number
) {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({
      name,
      brandId: BRAND,
      provider: "apollo",
      filters: { personTitles: ["Chiropractor"] },
      apolloAudienceId: "apollo-aud-1",
      ...(nlPrompt ? { nlPrompt } : {}),
      ...(apolloCount !== undefined ? { apolloCount } : {}),
    });
  expect(res.status).toBe(201);
  const id = res.body.audience.id as string;
  await db
    .update(audiences)
    .set({ description: "LLM rewrite of the filters", nlPrompt })
    .where(eq(audiences.id, id));
  return id;
}

function serveNext(id: string) {
  return request(app).post(`/orgs/audiences/${id}/serve-next`).set(getAuthHeaders());
}

// Route apollo + chat. `verdicts` maps an apollo person id to Jev's
// yes-probability. The judged state carries the SNAPSHOT, which holds no person
// id — so the mock identifies the candidate by its title, as the model would.
function mockFleet(opts: {
  pages: { id: string; title: string }[][];
  verdicts: Record<string, number>;
  chatFails?: boolean;
}) {
  const titleToId = new Map<string, string>();
  for (const page of opts.pages) {
    for (const t of page) titleToId.set(t.title, t.id);
  }
  let page = 0;
  const enriched: string[] = [];
  const screened: string[] = [];
  const targets: string[] = [];
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/search/next")) {
      const people = (opts.pages[page] ?? []).map((t) => teaser(t.id, t.title));
      page += 1;
      return ok({ people, done: people.length === 0, totalEntries: people.length });
    }
    if (u.endsWith("/orgs/judgments")) {
      if (opts.chatFails)
        return { ok: false, status: 500, text: async () => "chat down", json: async () => ({}) };
      const body = JSON.parse(init.body ?? "{}") as {
        state: { targetAudience: string; candidate: { title: string } };
      };
      const id = titleToId.get(body.state.candidate.title);
      if (!id) throw new Error("screen state named no known candidate: " + init.body);
      screened.push(id);
      targets.push(body.state.targetAudience);
      return ok({
        model: "jev-1.13.0",
        answers: { answer: { type: "noul", noul: opts.verdicts[id] } },
      });
    }
    if (u.endsWith("/enrich")) {
      const body = JSON.parse(init.body ?? "{}") as { apolloPersonId?: string };
      const id = body.apolloPersonId ?? "";
      enriched.push(id);
      return ok({ person: revealed(id, `${id}@acme.com`) });
    }
    throw new Error("unexpected url " + u);
  });
  return { enriched, screened, targets };
}


// Seed `n` verdicts for an audience, `passes` of them passes, oldest first, as if
// judged under `opts` (defaults: the question the screen asks today).
async function seedVerdicts(
  audienceId: string,
  n: number,
  passes: number,
  opts: { targetText?: string; bar?: string; startMs?: number } = {}
) {
  const [row] = await db.select().from(audiences).where(eq(audiences.id, audienceId));
  const target = screenTarget(row)!;
  const text = opts.targetText ?? target.text;
  const bar = opts.bar ?? screenBarTag();
  const start = opts.startMs ?? Date.now() - 3_600_000;
  const rows = Array.from({ length: n }, (_, i) => {
    // Passes spread evenly through the window, not bunched at one end.
    const verdict = passes > 0 && i % Math.floor(n / passes) === 0 && i / Math.floor(n / passes) < passes;
    return {
      orgId: row.orgId,
      audienceId,
      providerPersonId: `seed-${i}`,
      linkedinUrl: null,
      teaser: { name: "S", title: "Physician" } as never,
      verdict,
      yesProbability: verdict ? 0.9 : 0.05,
      reason: `P(yes)=${verdict ? "0.900" : "0.050"} ${bar}`,
      model: "typesafe/jev-1.13.0",
      promptVersion: SCREEN_PROMPT_VERSION,
      targetText: text,
      targetField: target.field,
      createdAt: new Date(start + i),
    };
  });
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(audienceTeaserScreenings).values(rows.slice(i, i + 500));
  }
}

function page(prefix: string, n: number, title: string) {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, title: `${title} ${i}` }));
}

describe("screen yield: an audience the screen has exhausted stops costing screens", () => {
  it("answers exhausted, screens and reveals nobody, persists Remaining, asks the refill", async () => {
    const calls = mockFleet({
      pages: [[{ id: "c1", title: "Chiropractor" }]],
      verdicts: { c1: 0.95 },
    });
    const id = await createDescribedAudience("US Chiropractic Clinicians", "practicing chiropractors in the US", 41954);
    // Shockwavecenters 2026-10-04: 2 passes in its last 1,000 screens.
    await seedVerdicts(id, SCREEN_YIELD_WINDOW, 2);

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "exhausted", person: null });
    expect(calls.screened).toEqual([]);
    expect(calls.enriched).toEqual([]);

    // Same as a walked-out audience: the reachable ceiling is written, so the
    // list's Remaining reads what is truly left and campaign-service moves on.
    const [row] = await db.select().from(audiences).where(eq(audiences.id, id));
    expect(row.reachableCount).toBe(0);
    const list = await request(app).get("/orgs/audiences").set(getAuthHeaders());
    const item = list.body.audiences.find((a: { id: string }) => a.id === id);
    expect(item.availableToContactCount).toBe(0);
    // The audience is never edited: still active, same filters.
    expect(row.status).toBe("active");
    expect(row.filters).toEqual({ personTitles: ["Chiropractor"] });

    expect(refillSweep).toHaveBeenCalledTimes(1);
    expect(refillSweep).toHaveBeenCalledWith({ brandId: BRAND });
    // A campaign retrying the dead audience does not re-run the sweep each time.
    await serveNext(id);
    expect(refillSweep).toHaveBeenCalledTimes(1);
  });

  it("keeps serving a selective but productive audience (12 passes in 1,000)", async () => {
    const calls = mockFleet({
      pages: [[{ id: "c1", title: "Chiropractor" }]],
      verdicts: { c1: 0.95 },
    });
    const id = await createDescribedAudience("Chiros", "practicing chiropractors in the US");
    await seedVerdicts(id, SCREEN_YIELD_WINDOW, 12);

    const res = await serveNext(id);
    expect(res.body.status).toBe("served");
    expect(calls.enriched).toEqual(["c1"]);
    expect(refillSweep).not.toHaveBeenCalled();
  });

  it("keeps serving a new audience whose window is not full yet, even at zero passes", async () => {
    const calls = mockFleet({
      pages: [[{ id: "c1", title: "Chiropractor" }]],
      verdicts: { c1: 0.95 },
    });
    const id = await createDescribedAudience("Chiros", "practicing chiropractors in the US");
    await seedVerdicts(id, SCREEN_YIELD_WINDOW - 1, 0);

    const res = await serveNext(id);
    expect(res.body.status).toBe("served");
    expect(calls.screened).toEqual(["c1"]);
  });

  it("a dead window under another text or another bar does not count: a new question starts fresh", async () => {
    const calls = mockFleet({
      pages: [[{ id: "c1", title: "Chiropractor" }]],
      verdicts: { c1: 0.95 },
    });
    const id = await createDescribedAudience("Chiros", "practicing chiropractors in the US");
    // "European Union" 2026-09-29: dead under the retired 0.80 bar, productive at 0.50.
    await seedVerdicts(id, SCREEN_YIELD_WINDOW, 0, { bar: "threshold>0.8" });
    await seedVerdicts(id, SCREEN_YIELD_WINDOW, 0, { targetText: "an older text of this audience" });

    const res = await serveNext(id);
    expect(res.body.status).toBe("served");
    expect(calls.enriched).toEqual(["c1"]);
  });

  it("stops mid-call once its own rejections fill a dead window, without dropping an unjudged teaser", async () => {
    // 950 dead verdicts before the call: not a full window, so the walk starts.
    // Every teaser Apollo returns is rejected; after 100 more screens the last
    // 1,000 hold no pass and the call ends exhausted instead of walking on.
    const rejects = page("r", 150, "Physician");
    const verdicts = Object.fromEntries(rejects.map((t) => [t.id, 0.05]));
    const calls = mockFleet({ pages: [rejects], verdicts });
    const id = await createDescribedAudience("Chiros", "practicing chiropractors in the US");
    await seedVerdicts(id, 950, 0, { startMs: Date.now() - 7_200_000 });

    const res = await serveNext(id);
    expect(res.body).toEqual({ status: "exhausted", person: null });
    expect(calls.screened).toHaveLength(100);
    expect(calls.enriched).toEqual([]);
    // The 50 teasers never screened are still buffered, not lost.
    const bronze = await db
      .select()
      .from(audienceTeaserScreenings)
      .where(eq(audienceTeaserScreenings.audienceId, id));
    expect(bronze).toHaveLength(1050);
    const buffered = await db
      .select()
      .from(audienceTeaserBuffer)
      .where(eq(audienceTeaserBuffer.audienceId, id));
    expect(buffered).toHaveLength(50);
    expect(refillSweep).toHaveBeenCalledWith({ brandId: BRAND });
  });
});
