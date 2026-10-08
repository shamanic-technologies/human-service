import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// MULTI-SOURCE TAGS: a person an audience's free search finds while they are
// already taken for the brand is recorded as found by that audience too
// (provenance found_taken), never served again, never paid for.
//
// Every revealed address reads as deliverable, unless the provider's answer
// carries a verdict (the not_deliverable case below), which is then read as is.
vi.mock("../../src/lib/email-verification.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readEmailVerification: (p: string, raw: unknown, email: string | null | undefined) =>
      raw
        ? (actual.readEmailVerification as (a: string, b: unknown, c: unknown) => unknown)(p, raw, email)
        : email
          ? { verdict: "valid", deliverable: true }
          : null,
  };
});
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audienceMembers, audiences, leadServes, people } from "../../src/db/schema.js";

// Gates with their own suites are no-ops here; this file is about the
// candidate flow (free next → billed reveal / decline).
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
// A yield-exhausted audience asks the refill sweep; not this suite's subject.
vi.mock("../../src/services/audience-refill.js", () => ({
  runAudienceRefillSweep: vi.fn(async () => ({})),
}));

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000c1";
const ORG = getAuthHeaders()["x-org-id"];

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
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

function teaser(id: string, title: string, domain: string | null = `${id}.example`) {
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
    organizationName: `Org ${id}`,
    organizationDomain: domain,
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

function mockApollo(pages: string[][]) {
  let page = 0;
  const enriched: string[] = [];
  const judged: string[] = [];
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/search/next")) {
      const people = (pages[page] ?? []).map((id) => teaser(id, `Chiropractor ${id}`));
      page += 1;
      return ok({ people, done: people.length === 0, totalEntries: people.length });
    }
    if (u.endsWith("/enrich")) {
      const id = (JSON.parse(init.body ?? "{}") as { apolloPersonId: string }).apolloPersonId;
      enriched.push(id);
      return ok({
        person: { ...teaser(id, "Chiropractor"), lastName: "D", name: "C D", email: `${id}@x.com`, emailStatus: "verified" },
      });
    }
    if (u.endsWith("/orgs/judgments")) {
      judged.push(u);
      throw new Error("the candidate path must never screen");
    }
    throw new Error("unexpected url " + u);
  });
  return { enriched, judged };
}

async function createAudience(name: string, buyingSignal = false) {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({
      name,
      brandId: BRAND,
      provider: "apollo",
      filters: { personTitles: ["Chiropractor"] },
      apolloAudienceId: `apollo-${name}`,
      nlPrompt: "Chiropractors who own their clinic",
      apolloCount: 100,
    });
  expect(res.status).toBe(201);
  const id = res.body.audience.id as string;
  await db
    .update(audiences)
    .set({
      targetText: "Chiropractors who own their clinic",
      ...(buyingSignal
        ? { filters: { person_titles: ["Chiropractor"], buying_signal: { type: "hiring", windowDays: 30 } } }
        : {}),
    })
    .where(eq(audiences.id, id));
  return id;
}

const next = (id: string) =>
  request(app).post(`/orgs/audiences/${id}/candidates/next`).set(getAuthHeaders());
const reveal = (id: string, c: string) =>
  request(app).post(`/orgs/audiences/${id}/candidates/${c}/reveal`).set(getAuthHeaders()).send({});
const internal = (path: string) =>
  request(app).get(path).set({ "X-API-Key": "test-api-key" });

async function membershipsOf(apolloId: string) {
  const rows = await db
    .select({ audienceId: audienceMembers.audienceId, provenance: audienceMembers.provenance })
    .from(audienceMembers)
    .innerJoin(people, eq(people.id, audienceMembers.personId))
    .where(eq(people.apolloPersonId, apolloId));
  return rows.sort((a, b) => a.provenance.localeCompare(b.provenance));
}

describe("multi-source provenance", () => {
  it("a teaser already served under A, found by B's free search, is tagged on B and not served again", async () => {
    const a = await createAudience("Cold A");
    const b = await createAudience("Signal B", true);
    // A's search: p1, p2. B's search (refill): p1 (taken by then), p3.
    const fleet = mockApollo([["p1", "p2"], ["p1", "p3"]]);
    const c1 = (await next(a)).body.candidate.candidateId as string;
    expect((await reveal(a, c1)).body.status).toBe("served");

    const res = await next(b);
    expect(res.body.candidate.providerPersonId).toBe("p3");
    // One paid reveal in total (p1 under A): tagging B cost nothing.
    expect(fleet.enriched).toEqual(["p1"]);
    expect(await db.select().from(leadServes)).toHaveLength(1);
    expect(await membershipsOf("p1")).toEqual([
      { audienceId: b, provenance: "found_taken" },
      { audienceId: a, provenance: "served" },
    ]);
  });

  it("a buffered teaser served elsewhere since is tagged at pop time", async () => {
    const a = await createAudience("Cold A");
    const b = await createAudience("Signal B", true);
    // Search calls in order: A [p1,p2], B [p3,p2], B refill [] (exhausted).
    const fleet = mockApollo([["p1", "p2"], ["p3", "p2"], []]);
    await next(a); // offers p1, buffers p2 for A
    await next(b); // offers p3, buffers p2 for B
    const c2 = (await next(a)).body.candidate.candidateId as string; // p2 for A
    expect((await reveal(a, c2)).body.status).toBe("served");
    const res = await next(b); // pops p2: taken ⟹ tagged, then exhausted
    expect(res.body.status).toBe("exhausted");
    expect(fleet.enriched).toEqual(["p2"]);
    expect(await membershipsOf("p2")).toEqual([
      { audienceId: b, provenance: "found_taken" },
      { audienceId: a, provenance: "served" },
    ]);

    // Per person, raw: p2 carries both audiences and both lists.
    const m = await internal(`/internal/brands/${BRAND}/memberships?orgId=${ORG}`);
    expect(m.status).toBe(200);
    expect(m.body.total).toBe(1);
    expect(m.body.people[0].memberships.map((x: { audienceId: string; list: string; provenance: string }) => [x.audienceId, x.list, x.provenance]).sort()).toEqual(
      [
        [a, "apollo_search", "served"],
        [b, "apollo_buying_signal", "found_taken"],
      ].sort()
    );

    // Per audience: B's one member was also found by another list.
    const o = await internal(`/internal/brands/${BRAND}/audience-overlap`);
    expect(o.status).toBe(200);
    expect(o.body).toMatchObject({ people: 1, peopleInSeveralAudiences: 1, peopleInSeveralLists: 1 });
    const ob = o.body.audiences.find((x: { audienceId: string }) => x.audienceId === b);
    expect(ob).toMatchObject({ memberCount: 1, servedCount: 0, foundTakenCount: 1, alsoInOtherAudienceCount: 1, alsoInOtherListCount: 1 });

    // The lead's card stays the audience that SERVED it.
    const r = await request(app)
      .post("/internal/audiences/resolve")
      .set({ "X-API-Key": "test-api-key", "Content-Type": "application/json" })
      .send({ orgId: ORG, brandId: BRAND, emails: ["p2@x.com"] });
    expect(r.body.byEmail["p2@x.com"].id).toBe(a);

    // Stats name both audiences with their provenance.
    const s = await request(app).post("/orgs/audiences/stats").set(getAuthHeaders()).send({ emails: ["p2@x.com"] });
    expect(s.body.matched[0].audiences.map((x: { audienceId: string; provenance: string }) => [x.audienceId, x.provenance]).sort()).toEqual(
      [[a, "served"], [b, "found_taken"]].sort()
    );
  });

  it("the memberships read 400s a bad brand id and 401s without a key", async () => {
    mockApollo([]);
    expect((await internal(`/internal/brands/nope/memberships`)).status).toBe(400);
    expect((await request(app).get(`/internal/brands/${BRAND}/memberships`)).status).toBe(401);
  });
});
