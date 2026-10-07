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
import { serveApollo } from "../helpers/serve-apollo.js";
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



// A linkedin_engagement signal audience (apollo-service v0.39.29): created
// through POST /orgs/audiences/signal, served through the candidate API exactly
// like any apollo pointer audience. The engager teasers (li:<profileId>) are
// offered free so the caller can screen them BEFORE the paid reveal, the
// reveal's buyingSignal + engagement evidence reach the served person, and
// apollo's `done` reads as exhausted.

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000b1";
const PAGES = ["https://www.linkedin.com/company/lemlist/"];
const STORED_FILTERS = {
  buying_signal: { type: "linkedin_engagement", window_days: 30, competitor_pages: PAGES },
};

const fetchSpy = vi.fn();
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
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}
function fail(status: number, json: unknown) {
  return { ok: false, status, json: async () => json, text: async () => JSON.stringify(json) };
}

const CREATED = {
  apolloAudienceId: "11111111-1111-4111-8111-111111111111",
  name: "Engaged with competitor posts (lemlist, last 30 days)",
  description: "People who reacted to or commented on a LinkedIn post published in the last 30 days by lemlist.",
  filters: STORED_FILTERS,
  count: null,
  window: { from: "2026-09-03", to: "2026-10-03" },
};

function createBody(extra: Record<string, unknown> = {}) {
  return {
    brandId: BRAND,
    nlPrompt: "heads of sales and growth at B2B SaaS companies",
    signal: { type: "linkedin_engagement", windowDays: 30, competitorPages: PAGES },
    ...extra,
  };
}

async function createAudience(extra: Record<string, unknown> = {}) {
  fetchSpy.mockImplementationOnce(async () => ok(CREATED));
  const res = await request(app).post("/orgs/audiences/signal").set(getAuthHeaders()).send(createBody(extra));
  expect(res.status).toBe(201);
  return res.body.audience as { id: string; [k: string]: unknown };
}

// An engager teaser as apollo-service serves it on /search/next.
function engager(id: string, title: string) {
  return {
    id,
    firstName: "Ana",
    lastName: "Silva",
    name: "Ana Silva",
    email: null,
    emailStatus: null,
    title,
    headline: `${title} at Acme`,
    seniority: null,
    linkedinUrl: `https://www.linkedin.com/in/${id.slice(3)}`,
    photoUrl: null,
    city: null,
    state: null,
    country: null,
    organizationName: "Acme",
    organizationDomain: null,
    organizationWebsiteUrl: null,
    organizationIndustry: null,
    organizationSize: null,
    organizationLinkedinUrl: null,
    organizationLogoUrl: null,
    organizationCity: null,
    organizationState: null,
    organizationCountry: null,
  };
}

const EVIDENCE = {
  type: "linkedin_engagement",
  occurredOn: "2026-09-27",
  fact: "Reacted (like) to a LinkedIn post by lemlist published around September 27, 2026",
  source: "linkedin:company/lemlist",
  sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
  engagement: {
    competitorPage: "https://www.linkedin.com/company/lemlist/",
    postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
    postPublishedOn: "2026-09-27",
    kind: "reaction",
    reactionType: "LIKE",
    commentText: null,
    commentedAt: null,
  },
};

function mockServe(opts: { pages: { id: string; title: string }[][] }) {
  let page = 0;
  const calls = {
    enriched: [] as string[],
    judged: 0,
    searchBodies: [] as unknown[],
    searchAudienceHeaders: [] as (string | undefined)[],
    enrichAudienceHeaders: [] as (string | undefined)[],
    dryRuns: 0,
  };
  fetchSpy.mockImplementation(async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    if (u.endsWith("/search/next")) {
      calls.searchBodies.push(JSON.parse(init.body ?? "{}"));
      calls.searchAudienceHeaders.push(init.headers?.["x-audience-id"]);
      const people = (opts.pages[page] ?? []).map((t) => engager(t.id, t.title));
      page += 1;
      return ok({ people, done: page >= opts.pages.length && people.length === 0, totalEntries: 3, source: "linkedin_engagement" });
    }
    if (u.endsWith("/orgs/judgments")) {
      // The screen is lead-service's since 2026-10-07: human-service never asks.
      calls.judged += 1;
      throw new Error("human-service must never screen");
    }
    if (u.endsWith("/enrich")) {
      const id = (JSON.parse(init.body ?? "{}") as { apolloPersonId: string }).apolloPersonId;
      calls.enriched.push(id);
      calls.enrichAudienceHeaders.push(init.headers?.["x-audience-id"]);
      return ok({
        person: { ...engager(id, "Head of Sales"), email: `${id.slice(3)}@acme.com`, emailStatus: "verified" },
        emailVerification: { verdict: "valid", deliverable: true },
        buyingSignal: EVIDENCE,
        source: "linkedin_engagement",
      });
    }
    if (u.includes("/dry-run")) {
      calls.dryRuns += 1;
      return fail(400, { type: "validation", error: "linkedin_engagement is not an Apollo search" });
    }
    throw new Error("unexpected url " + u);
  });
  return calls;
}

describe("POST /orgs/audiences/signal (linkedin_engagement)", () => {
  it("creates the audience on apollo-service and stores a servable pointer with no size", async () => {
    let sent: { url: string; body: unknown } | null = null;
    fetchSpy.mockImplementationOnce(async (url: string, init: { body?: string }) => {
      sent = { url: String(url), body: JSON.parse(init.body ?? "{}") };
      return ok(CREATED);
    });
    const res = await request(app)
      .post("/orgs/audiences/signal")
      .set(getAuthHeaders())
      .send(createBody({ status: "paused", offerId: "22222222-2222-4222-8222-222222222222" }));
    expect(res.status).toBe(201);
    expect(sent!.url).toBe("http://apollo:8080/audiences/signal");
    expect(sent!.body).toEqual({
      filters: {},
      brandId: BRAND,
      signal: { type: "linkedin_engagement", windowDays: 30, competitorPages: PAGES },
    });
    const a = res.body.audience;
    expect(a).toMatchObject({
      name: CREATED.name,
      provider: "apollo",
      apolloAudienceId: CREATED.apolloAudienceId,
      filters: STORED_FILTERS,
      apolloCount: null,
      status: "paused",
      offerId: "22222222-2222-4222-8222-222222222222",
      nlPrompt: "heads of sales and growth at B2B SaaS companies",
    });

    // Size is UNKNOWN, never 0 ("served out"): the list omits the three figures.
    const list = await request(app).get(`/orgs/audiences?brandId=${BRAND}&status=paused`).set(getAuthHeaders());
    expect(list.status).toBe(200);
    const item = list.body.audiences.find((x: { id: string }) => x.id === a.id);
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty("sizeCount");
    expect(item).not.toHaveProperty("availableToContactCount");
    expect(item).not.toHaveProperty("availableToContactPct");
  });

  it("relays apollo-service's named 400 for malformed competitor pages", async () => {
    fetchSpy.mockImplementationOnce(async () =>
      fail(400, { type: "validation", error: "competitor_pages must be 1-3 LinkedIn company page URLs" })
    );
    const res = await request(app)
      .post("/orgs/audiences/signal")
      .set(getAuthHeaders())
      .send(createBody({ signal: { type: "linkedin_engagement", windowDays: 30, competitorPages: ["not a url"] } }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("competitor_pages must be 1-3 LinkedIn company page URLs");
    expect(res.body.upstreamStatus).toBe(400);
    expect(await db.select().from(audiences)).toHaveLength(0);
  });

  it("relays apollo-service's named 400 for Apollo filters beside the signal", async () => {
    let sentFilters: unknown;
    fetchSpy.mockImplementationOnce(async (_url: string, init: { body?: string }) => {
      sentFilters = (JSON.parse(init.body ?? "{}") as { filters: unknown }).filters;
      return fail(400, {
        type: "validation",
        error: "Apollo filters cannot be combined with the linkedin_engagement signal (its people are LinkedIn engagers, not an Apollo search): personTitles",
        fields: ["personTitles"],
      });
    });
    const res = await request(app)
      .post("/orgs/audiences/signal")
      .set(getAuthHeaders())
      .send(createBody({ filters: { personTitles: ["CEO"] } }));
    expect(sentFilters).toEqual({ personTitles: ["CEO"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Apollo filters cannot be combined with the linkedin_engagement signal/);
  });

  it("refuses another signal kind on this route", async () => {
    const res = await request(app)
      .post("/orgs/audiences/signal")
      .set(getAuthHeaders())
      .send(createBody({ signal: { type: "hiring", windowDays: 30, competitorPages: PAGES } }));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("409s on a name already taken for the brand", async () => {
    await createAudience({ name: "Lemlist engagers" });
    fetchSpy.mockImplementationOnce(async () => ok({ ...CREATED, apolloAudienceId: "33333333-3333-4333-8333-333333333333" }));
    const res = await request(app)
      .post("/orgs/audiences/signal")
      .set(getAuthHeaders())
      .send(createBody({ name: "Lemlist engagers" }));
    expect(res.status).toBe(409);
  });
});

describe("a linkedin_engagement audience is served through the candidate API", () => {
  it("offers each engager free, the caller declines one and reveals the other: the signal is served under THIS audience's id", async () => {
    const audience = await createAudience();
    const calls = mockServe({
      pages: [[{ id: "li:off", title: "Recruiter" }, { id: "li:on", title: "Head of Sales" }]],
    });
    // A stale inbound x-audience-id must not win over the served audience.
    const headers = { ...getAuthHeaders(), "x-audience-id": "00000000-0000-4000-8000-0000000000ee" };
    const first = await request(app).post(`/orgs/audiences/${audience.id}/candidates/next`).set(headers);
    expect(first.body.status).toBe("candidate");
    expect(first.body.candidate.providerPersonId).toBe("li:off");
    // The engager's name, title, headline and employer are what the caller screens.
    expect(first.body.candidate.person).toMatchObject({ name: "Ana Silva", title: "Recruiter" });
    expect(first.body.candidate.person.headline).toContain("at Acme");
    const declined = await request(app)
      .post(`/orgs/audiences/${audience.id}/candidates/${first.body.candidate.candidateId}/decline`)
      .set(headers)
      .send({ reason: "not a buyer" });
    expect(declined.status).toBe(200);

    const second = await request(app).post(`/orgs/audiences/${audience.id}/candidates/next`).set(headers);
    expect(second.body.candidate.providerPersonId).toBe("li:on");
    const res = await request(app)
      .post(`/orgs/audiences/${audience.id}/candidates/${second.body.candidate.candidateId}/reveal`)
      .set(headers)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    // The declined engager was NEVER revealed, and nothing was screened here.
    expect(calls.enriched).toEqual(["li:on"]);
    expect(calls.judged).toBe(0);
    expect(res.body.person.email).toBe("on@acme.com");
    expect(res.body.person.buyingSignal).toEqual(EVIDENCE);
    expect(res.body.person.buyingSignal.type).toBe("linkedin_engagement");
    // The stored criterion is forwarded verbatim, under THIS audience's id on
    // both the free search and the paid reveal (apollo-service keys its
    // no-repeat on x-audience-id).
    expect(calls.searchBodies[0]).toEqual({ searchParams: STORED_FILTERS });
    expect(calls.searchAudienceHeaders[0]).toBe(audience.id);
    expect(calls.enrichAudienceHeaders).toEqual([audience.id]);
    // No Apollo count exists for this kind: the stale-count refresh never asks.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.dryRuns).toBe(0);
  });

  it("serve-next refuses it (422) without calling apollo-service", async () => {
    const audience = await createAudience();
    const calls = mockServe({ pages: [[{ id: "li:on", title: "Head of Sales" }]] });
    const res = await request(app).post(`/orgs/audiences/${audience.id}/serve-next`).set(getAuthHeaders());
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.searchBodies).toHaveLength(0);
    expect(calls.enriched).toEqual([]);
  });

  it("reads exhausted when apollo says done, and the walked pool becomes its size", async () => {
    const audience = await createAudience();
    mockServe({ pages: [[{ id: "li:on", title: "Head of Sales" }], []] });
    const first = await serveApollo(app, audience.id);
    expect(first.body.status).toBe("served");
    const second = await serveApollo(app, audience.id);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: "exhausted", person: null });

    const list = await request(app).get(`/orgs/audiences?brandId=${BRAND}`).set(getAuthHeaders());
    const item = list.body.audiences.find((x: { id: string }) => x.id === audience.id);
    expect(item.sizeCount).toBe(1);
    expect(item.availableToContactCount).toBe(0);
  });

  it("is not previewable (no Apollo sample exists for it)", async () => {
    const audience = await createAudience();
    const res = await request(app).get(`/orgs/audiences/${audience.id}/preview`).set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("unavailable");
    expect(res.body.reason).toBe("provider_not_previewable");
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the create only
  });
});
