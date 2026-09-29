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
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  audiences,
  audienceScreenedOut,
  audienceTeaserScreenings,
} from "../../src/db/schema.js";

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

describe("pre-pay teaser screening", () => {
  it("passes an on-target teaser through to the billed reveal", async () => {
    const calls = mockFleet({
      pages: [[{ id: "p1", title: "Chiropractor" }]],
      verdicts: { p1: 0.95 },
    });
    const id = await createDescribedAudience("Chiros", "chiropractors who own their practice");

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("p1@acme.com");
    expect(calls.screened).toEqual(["p1"]);
    expect(calls.enriched).toEqual(["p1"]);
    // Judged against the customer's own words, never the LLM description.
    expect(calls.targets).toEqual(["chiropractors who own their practice"]);
  });

  it("a coin flip (0.50, not above) is rejected and never enriched", async () => {
    const calls = mockFleet({
      pages: [[{ id: "p1", title: "Group CFO" }, { id: "p2", title: "Chiropractor" }]],
      verdicts: { p1: 0.5, p2: 0.6 },
    });
    const id = await createDescribedAudience("Chiros", "chiropractors who own their practice");

    const res = await serveNext(id);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("p2@acme.com");
    expect(calls.screened).toEqual(["p1", "p2"]);
    expect(calls.enriched).toEqual(["p2"]);
  });

  it("an off-target teaser is NEVER enriched — the credit is not spent", async () => {
    const calls = mockFleet({
      pages: [[{ id: "p1", title: "Marketing Intern" }, { id: "p2", title: "Chiropractor" }]],
      verdicts: { p1: 0.3, p2: 0.95 },
    });
    const id = await createDescribedAudience("Chiros", "chiropractors who own their practice");

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("p2@acme.com");
    // Both judged, only the on-target one paid for.
    expect(calls.screened).toEqual(["p1", "p2"]);
    expect(calls.enriched).toEqual(["p2"]);
  });

  it("records the verdict in bronze and the rejection in silver", async () => {
    mockFleet({
      pages: [[{ id: "p1", title: "Marketing Intern" }, { id: "p2", title: "Chiropractor" }]],
      verdicts: { p1: 0.3, p2: 0.95 },
    });
    const id = await createDescribedAudience("Chiros", "chiropractors who own their practice");
    await serveNext(id);

    const bronze = await db
      .select()
      .from(audienceTeaserScreenings)
      .where(eq(audienceTeaserScreenings.audienceId, id));
    // EVERY verdict, passes included — the pass is what makes a later prompt
    // change measurable against the history.
    expect(bronze).toHaveLength(2);
    const rejected = bronze.find((r) => r.providerPersonId === "p1");
    expect(rejected?.verdict).toBe(false);
    expect(rejected?.yesProbability).toBe(0.3);
    expect(rejected?.model).toBe("typesafe/jev-1.13.0");
    expect(rejected?.promptVersion).toBe("v2");
    // The snapshot it was judged on is stored with it.
    expect(rejected?.teaser.title).toBe("Marketing Intern");
    const passed = bronze.find((r) => r.providerPersonId === "p2");
    expect(passed?.verdict).toBe(true);
    expect(passed?.yesProbability).toBe(0.95);

    const silver = await db
      .select()
      .from(audienceScreenedOut)
      .where(eq(audienceScreenedOut.audienceId, id));
    expect(silver).toHaveLength(1);
    expect(silver[0].providerPersonId).toBe("p1");
  });

  it("never re-buffers or re-screens a person it already rejected", async () => {
    // p1 is rejected on page 1, then apollo surfaces it again on page 2.
    const calls = mockFleet({
      pages: [
        [{ id: "p1", title: "Marketing Intern" }],
        [{ id: "p1", title: "Marketing Intern" }, { id: "p2", title: "Chiropractor" }],
      ],
      verdicts: { p1: 0.3, p2: 0.95 },
    });
    const id = await createDescribedAudience("Chiros", "chiropractors who own their practice");

    const res = await serveNext(id);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("p2@acme.com");
    // p1 judged ONCE across both pages.
    expect(calls.screened).toEqual(["p1", "p2"]);
  });

  it("shrinks the audience SIZE by the people the screen disqualified", async () => {
    mockFleet({
      pages: [[{ id: "p1", title: "Marketing Intern" }, { id: "p2", title: "Chiropractor" }]],
      verdicts: { p1: 0.3, p2: 0.95 },
    });
    const id = await createDescribedAudience("Chiros", "chiropractors who own their practice", 7000);

    const before = await request(app).get("/orgs/audiences").set(getAuthHeaders());
    expect(before.body.audiences.find((a: { id: string }) => a.id === id).sizeCount).toBe(7000);

    await serveNext(id);

    // One person provably not in this audience ⟹ the pool is 6,999, not 7,000
    // with a footnote. Size and Remaining must not contradict each other.
    const after = await request(app).get("/orgs/audiences").set(getAuthHeaders());
    const row = after.body.audiences.find((a: { id: string }) => a.id === id);
    expect(row.sizeCount).toBe(6999);
  });

  it("fails loud when chat-service is down — the credit is not spent on an unjudged teaser", async () => {
    const calls = mockFleet({
      pages: [[{ id: "p1", title: "Chiropractor" }]],
      verdicts: { p1: 0.95 },
      chatFails: true,
    });
    const id = await createDescribedAudience("Chiros", "chiropractors who own their practice");

    const res = await serveNext(id);
    expect(res.status).toBe(502);
    expect(calls.enriched).toEqual([]);
  });

  it("serves unscreened when the audience carries no nl_prompt — never falls back to description", async () => {
    // No customer words ⟹ nothing to judge against. The LLM description is set
    // on this row and must NOT be used as a stand-in.
    const calls = mockFleet({
      pages: [[{ id: "p1", title: "Chiropractor" }]],
      verdicts: {},
    });
    const id = await createDescribedAudience("Undescribed", null);

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(calls.screened).toEqual([]);
    expect(calls.enriched).toEqual(["p1"]);
  });
});
