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
import { SCREEN_YIELD_WINDOW } from "../../src/services/teaser-screening.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audienceCandidates, audiences } from "../../src/db/schema.js";

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


// Yield: an apollo audience whose recent decisions are nearly all declines has
// stopped producing people. Since 2026-10-07 the decisions are lead-service's
// (candidate API reveal / decline; the screen moved there), and the stop rule is
// applied to them: over the last SCREEN_YIELD_WINDOW decisions under the latest
// basis, fewer than 3 reveals ⟹ candidates/next answers exhausted, persists the
// reachable ceiling (Remaining) and asks the refill sweep. Every test here is
// about the SPEND: a dead audience must not keep paging and revealing.

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000b1";
const ORG = getAuthHeaders()["x-org-id"];

const fetchSpy = vi.fn();
const fetchBeforeThisSuite = globalThis.fetch;

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  refillSweep.mockClear();
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
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
    title: "Chiropractor",
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

function mockApollo(ids: string[]) {
  const calls = { searches: 0, enriched: [] as string[] };
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/search/next")) {
      const people = calls.searches === 0 ? ids.map(teaser) : [];
      calls.searches += 1;
      return ok({ people, done: people.length === 0, totalEntries: people.length });
    }
    if (u.endsWith("/enrich")) {
      const id = (JSON.parse(init.body ?? "{}") as { apolloPersonId?: string }).apolloPersonId ?? "";
      calls.enriched.push(id);
      return ok({ person: { ...teaser(id), lastName: "D", name: "C D", email: `${id}@acme.com`, emailStatus: "verified" } });
    }
    if (u.includes("/dry-run")) return ok({ total: 41954 });
    throw new Error("unexpected url " + u);
  });
  return calls;
}

async function createAudience(name: string, apolloCount?: number) {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({
      name,
      brandId: BRAND,
      provider: "apollo",
      filters: { personTitles: ["Chiropractor"] },
      apolloAudienceId: "apollo-aud-1",
      nlPrompt: "practicing chiropractors in the US",
      ...(apolloCount !== undefined ? { apolloCount } : {}),
    });
  expect(res.status).toBe(201);
  const id = res.body.audience.id as string;
  await db.update(audiences).set({ targetText: "practicing chiropractors in the US" }).where(eq(audiences.id, id));
  return id;
}

// Seed `n` caller decisions, `reveals` of them reveals spread through the
// window, the rest declines, all under `basis`.
async function seedDecisions(audienceId: string, n: number, reveals: number, basis = "criteria-v1") {
  const step = reveals > 0 ? Math.floor(n / reveals) : 0;
  const start = Date.now() - 3_600_000;
  const rows = Array.from({ length: n }, (_, i) => {
    const revealed = reveals > 0 && i % step === 0 && i / step < reveals;
    return {
      orgId: ORG,
      audienceId,
      providerPersonId: `seed-${i}`,
      status: (revealed ? "revealed" : "declined") as "revealed" | "declined",
      basis,
      decidedAt: new Date(start + i),
    };
  });
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(audienceCandidates).values(rows.slice(i, i + 500));
  }
}

const next = (id: string) =>
  request(app).post(`/orgs/audiences/${id}/candidates/next`).set(getAuthHeaders());

describe("yield: an audience the caller's screen has exhausted stops costing pages", () => {
  it("answers exhausted, pages and reveals nobody, persists Remaining, asks the refill once", async () => {
    const calls = mockApollo(["c1"]);
    const id = await createAudience("US Chiropractic Clinicians", 41954);
    // Shockwavecenters 2026-10-04: 2 passes in its last 1,000 screens.
    await seedDecisions(id, SCREEN_YIELD_WINDOW, 2);

    const res = await next(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "exhausted", candidate: null, reason: "yield_exhausted" });
    expect(calls.searches).toBe(0);
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

    await vi.waitFor(() => expect(refillSweep).toHaveBeenCalledTimes(1));
    expect(refillSweep).toHaveBeenCalledWith({ brandId: BRAND });
    // A campaign retrying the dead audience does not re-run the sweep each time.
    await next(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(refillSweep).toHaveBeenCalledTimes(1);
  });

  it("keeps offering a selective but productive audience (12 reveals in 1,000)", async () => {
    const calls = mockApollo(["c1"]);
    const id = await createAudience("Chiros");
    await seedDecisions(id, SCREEN_YIELD_WINDOW, 12);
    const res = await next(id);
    expect(res.body.status).toBe("candidate");
    expect(res.body.candidate.providerPersonId).toBe("c1");
    expect(calls.searches).toBe(1);
    expect(refillSweep).not.toHaveBeenCalled();
  });

  it("keeps offering a new audience whose window is not full yet, even at zero reveals", async () => {
    mockApollo(["c1"]);
    const id = await createAudience("Fresh chiros");
    await seedDecisions(id, SCREEN_YIELD_WINDOW - 1, 0);
    const res = await next(id);
    expect(res.body.status).toBe("candidate");
    expect(refillSweep).not.toHaveBeenCalled();
  });
});
