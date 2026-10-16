import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// CATCHALL-SERVE-OPTION-1013: `acceptedEmails` on serve-next / candidates.
// The provider's verdict is read as it answers it (the real reader).
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  audienceMembers,
  audiences,
  audienceTeaserScreenings,
  brandSuppressions,
  catchAllRereaches,
  leadServes,
  people,
} from "../../src/db/schema.js";

vi.mock("../../src/lib/lead-won.js", () => ({
  listWonEmails: vi.fn(async () => []),
  isEmailWon: vi.fn(async () => false),
  WonLeadsSourceError: class WonLeadsSourceError extends Error {},
  WonLeadsConfigError: class WonLeadsConfigError extends Error {},
}));
const bounced = vi.hoisted(() => ({ emails: new Set<string>() }));
vi.mock("../../src/services/bounces.js", () => ({
  filterBounced: vi.fn(async (_identity: unknown, items: unknown[]) => items),
  isEmailBounced: vi.fn(async (_identity: unknown, email: string | null) => bounced.emails.has(email ?? "")),
}));
vi.mock("../../src/lib/instantly-optouts.js", () => ({
  listStandingOptOutEmails: vi.fn(async () => []),
  isEmailOptedOut: vi.fn(async () => false),
  OptOutSourceError: class OptOutSourceError extends Error {},
  OptOutConfigError: class OptOutConfigError extends Error {},
}));
vi.mock("../../src/services/audience-refill.js", () => ({
  runAudienceRefillSweep: vi.fn(async () => ({})),
}));

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000c2";
const ORG = getAuthHeaders()["x-org-id"];

const fetchSpy = vi.fn();
const fetchBeforeThisSuite = globalThis.fetch;

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  bounced.emails.clear();
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
    state: "Texas",
    country: "United States",
    organizationName: `Org ${id}`,
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

// Apollo: one page of teasers, then nobody; each reveal verified with the
// verdict named for that person (valid by default).
function mockApollo(pages: string[][], verdicts: Record<string, string> = {}) {
  let page = 0;
  const enriched: string[] = [];
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/search/next")) {
      const people = (pages[page] ?? []).map((id) => teaser(id));
      page += 1;
      return ok({ people, done: people.length === 0, totalEntries: people.length });
    }
    if (u.endsWith("/enrich")) {
      const id = (JSON.parse(init.body ?? "{}") as { apolloPersonId: string }).apolloPersonId;
      enriched.push(id);
      const verdict = verdicts[id] ?? "valid";
      return ok({
        person: { ...teaser(id), lastName: "D", name: "C D", email: `${id}@x.com`, emailStatus: "verified" },
        emailVerification: { email: `${id}@x.com`, verdict, deliverable: verdict === "valid" },
      });
    }
    throw new Error("unexpected url " + u);
  });
  return { enriched };
}

async function createAudience() {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({
      name: "Chiros",
      brandId: BRAND,
      provider: "apollo",
      filters: { personTitles: ["Chiropractor"] },
      apolloAudienceId: "apollo-aud-1",
      nlPrompt: "Chiropractors who own their clinic",
      apolloCount: 100,
    });
  expect(res.status).toBe(201);
  const id = res.body.audience.id as string;
  await db.update(audiences).set({ targetText: "Chiropractors who own their clinic" }).where(eq(audiences.id, id));
  return id;
}

// A person revealed, verified catch_all and dropped by an earlier serve-next:
// the bronze serve + the brand claim + the teaser the screen judged.
async function seedDroppedCatchAll(
  audienceId: string,
  id: string,
  servedAt = new Date("2026-10-01T00:00:00Z"),
  emailVerdict = "catch_all"
) {
  await db.insert(leadServes).values({
    orgId: ORG,
    brandId: BRAND,
    provider: "apollo",
    providerPersonId: id,
    firstName: "Jane",
    lastName: "Roe",
    email: `${id}@x.com`,
    linkedinUrl: `linkedin.com/in/${id}`,
    companyDomain: `${id}.example`,
    audienceId,
    emailVerdict,
    servedAt,
  });
  await db.insert(brandSuppressions).values({ orgId: ORG, brandId: BRAND, emailNorm: `${id}@x.com`, providerPersonId: id });
  await db.insert(audienceTeaserScreenings).values({
    orgId: ORG,
    audienceId,
    providerPersonId: id,
    teaser: {
      name: "Jane R.",
      title: "Chiropractor",
      headline: null,
      seniority: "owner",
      city: "Austin",
      state: "Texas",
      country: "United States",
      organizationName: "Roe Chiropractic",
      organizationIndustry: "health",
      organizationEmployees: 4,
      organizationCity: null,
      organizationState: null,
      organizationCountry: null,
      organizationKeywords: null,
    },
    verdict: true,
    model: "m",
    promptVersion: "v2",
  });
}

const serveNext = (id: string, body: object = {}) =>
  request(app).post(`/orgs/audiences/${id}/serve-next`).set(getAuthHeaders()).send(body);
const next = (id: string, body: object = {}) =>
  request(app).post(`/orgs/audiences/${id}/candidates/next`).set(getAuthHeaders()).send(body);
const reveal = (id: string, c: string, body: object = {}) =>
  request(app).post(`/orgs/audiences/${id}/candidates/${c}/reveal`).set(getAuthHeaders()).send(body);
const decline = (id: string, c: string) =>
  request(app).post(`/orgs/audiences/${id}/candidates/${c}/decline`).set(getAuthHeaders()).send({ reason: "no" });

const CATCH_ALL = { acceptedEmails: "valid_and_catch_all" };
const UNKNOWN = { acceptedEmails: "valid_catch_all_and_unknown" };

describe("acceptedEmails — validation", () => {
  it("400s an unknown value on every route", async () => {
    const id = await createAudience();
    for (const r of [serveNext(id, { acceptedEmails: "all" }), next(id, { acceptedEmails: "all" })]) {
      const res = await r;
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/acceptedEmails/);
    }
    const rv = await reveal(id, "00000000-0000-4000-8000-000000000001", { acceptedEmails: "all" });
    expect(rv.status).toBe(400);
  });
});

describe("serve-next — re-reach of catch-all people already paid for", () => {
  it("hands a dropped catch-all person to a caller asking for catch-all: no reveal, verdict on the answer, once", async () => {
    const id = await createAudience();
    await seedDroppedCatchAll(id, "p9");
    const fleet = mockApollo([[]]);

    const res = await serveNext(id, CATCH_ALL);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.emailVerdict).toBe("catch_all");
    expect(res.body.personId).toEqual(expect.any(String));
    expect(res.body.person).toMatchObject({
      email: "p9@x.com",
      firstName: "Jane",
      lastName: "Roe",
      title: "Chiropractor",
      providerPersonId: "p9",
      catchAll: true,
      country: "United States",
      organization: expect.objectContaining({ name: "Roe Chiropractic", domain: "p9.example" }),
    });
    expect(res.body.person.businessLanguages).toEqual(["en"]);
    expect(fleet.enriched).toEqual([]);
    // Recorded as handed once; membership tagged; no second bronze serve.
    const ledger = await db.select().from(catchAllRereaches);
    expect(ledger).toMatchObject([{ status: "handed", path: "serve_next", emailNorm: "p9@x.com" }]);
    expect(await db.select().from(leadServes)).toHaveLength(1);
    expect(await db.select().from(audienceMembers).where(eq(audienceMembers.audienceId, id))).toHaveLength(1);

    // Each person once: the next ask reveals someone new (here: nobody left).
    const again = await serveNext(id, CATCH_ALL);
    expect(again.body).toMatchObject({ status: "exhausted", person: null });
    expect(again.body).not.toHaveProperty("emailVerdict");
  });

  it("a caller that states nothing never gets them, and reads no emailVerdict", async () => {
    const id = await createAudience();
    await seedDroppedCatchAll(id, "p9");
    mockApollo([[]]);
    const res = await serveNext(id);
    expect(res.body).toEqual({ status: "exhausted", person: null });
    expect(await db.select().from(catchAllRereaches)).toHaveLength(0);
  });

  it("valid_only never re-reaches a catch-all person", async () => {
    const id = await createAudience();
    await seedDroppedCatchAll(id, "p9");
    mockApollo([[]]);
    const res = await serveNext(id, { acceptedEmails: "valid_only" });
    expect(res.body).toEqual({ status: "exhausted", person: null });
  });

  it("never re-reaches a person already handed for the brand, nor one a later check called unknown", async () => {
    const id = await createAudience();
    await seedDroppedCatchAll(id, "handed");
    const [p] = await db.insert(people).values({ orgId: ORG, emailNorm: "handed@x.com" }).returning();
    await db.insert(audienceMembers).values({ orgId: ORG, audienceId: id, personId: p.id, provenance: "served" });
    await seedDroppedCatchAll(id, "rechecked");
    await db.insert(leadServes).values({
      orgId: ORG, brandId: BRAND, provider: "apollo", providerPersonId: "rechecked",
      email: "rechecked@x.com", audienceId: id, emailVerdict: "unknown", servedAt: new Date("2026-10-05T00:00:00Z"),
    });
    mockApollo([[]]);
    const res = await serveNext(id, CATCH_ALL);
    expect(res.body).toMatchObject({ status: "exhausted" });
  });

  it("a gate that closed since (hard bounce) blocks the person for good", async () => {
    const id = await createAudience();
    await seedDroppedCatchAll(id, "p9");
    bounced.emails.add("p9@x.com");
    mockApollo([[]]);
    const res = await serveNext(id, CATCH_ALL);
    expect(res.body).toMatchObject({ status: "exhausted" });
    expect(await db.select().from(catchAllRereaches)).toMatchObject([{ status: "blocked", blockReason: "bounced" }]);
  });
});

describe("candidates — fresh reveal under the option", () => {
  it("serves a catch_all reveal to a caller asking for it, verdict on the answer", async () => {
    const id = await createAudience();
    mockApollo([["p1"]], { p1: "catch_all" });
    const c = (await next(id, CATCH_ALL)).body.candidate.candidateId;
    const res = await reveal(id, c, CATCH_ALL);
    expect(res.body).toMatchObject({ status: "served", emailVerdict: "catch_all", replayed: false });
    expect(res.body.person.email).toBe("p1@x.com");
    const [serve] = await db.select().from(leadServes);
    expect(serve.emailVerdict).toBe("catch_all");
    // Replay keeps the verdict.
    expect((await reveal(id, c, CATCH_ALL)).body).toMatchObject({ emailVerdict: "catch_all", replayed: true });
  });

  it("unknown stays never-deliverable whatever the option", async () => {
    const id = await createAudience();
    mockApollo([["p1"]], { p1: "unknown" });
    const c = (await next(id, CATCH_ALL)).body.candidate.candidateId;
    const res = await reveal(id, c, CATCH_ALL);
    expect(res.body).toEqual({ status: "not_served", person: null, reason: "not_deliverable", verdict: "unknown", replayed: false });
  });

  it("no option: catch_all dropped exactly as today; a valid serve carries no emailVerdict", async () => {
    const id = await createAudience();
    mockApollo([["p1", "p2"]], { p1: "catch_all" });
    const c1 = (await next(id)).body.candidate.candidateId;
    expect((await reveal(id, c1)).body).toEqual({
      status: "not_served", person: null, reason: "not_deliverable", verdict: "catch_all", replayed: false,
    });
    const c2 = (await next(id)).body.candidate.candidateId;
    const served = await reveal(id, c2);
    expect(served.body.status).toBe("served");
    expect(served.body).not.toHaveProperty("emailVerdict");
    // The same answer read by a caller stating the option names the verdict.
    expect((await reveal(id, c2, { acceptedEmails: "valid_only" })).body).toMatchObject({ emailVerdict: "valid", replayed: true });
  });
});

describe("candidates — re-reach of catch-all people already paid for", () => {
  it("re-offers a person dropped on the candidate path, and hands them without a second reveal", async () => {
    const id = await createAudience();
    const fleet = mockApollo([["p1"], []], { p1: "catch_all" });
    const c = (await next(id)).body.candidate.candidateId;
    expect((await reveal(id, c)).body).toMatchObject({ status: "not_served", verdict: "catch_all" });
    expect(fleet.enriched).toEqual(["p1"]);

    const offered = await next(id, CATCH_ALL);
    expect(offered.body.status).toBe("candidate");
    expect(offered.body.candidate.candidateId).toBe(c);
    expect(offered.body.candidate.providerPersonId).toBe("p1");

    const res = await reveal(id, c, CATCH_ALL);
    expect(res.body).toMatchObject({ status: "served", emailVerdict: "catch_all", replayed: false });
    expect(res.body.person.email).toBe("p1@x.com");
    expect(fleet.enriched).toEqual(["p1"]);
    expect(await db.select().from(leadServes)).toHaveLength(1);
    expect(await db.select().from(catchAllRereaches)).toMatchObject([{ status: "handed", path: "candidates" }]);

    // Once: the next ask has nobody.
    expect((await next(id, CATCH_ALL)).body).toMatchObject({ status: "exhausted" });
  });

  it("offers a person dropped by serve-next as a new candidate", async () => {
    const id = await createAudience();
    await seedDroppedCatchAll(id, "p9");
    const fleet = mockApollo([[]]);
    const offered = await next(id, CATCH_ALL);
    expect(offered.body.candidate).toMatchObject({
      providerPersonId: "p9",
      person: { title: "Chiropractor", country: "United States" },
      company: { name: "Roe Chiropractic", domain: "p9.example" },
    });
    const res = await reveal(id, offered.body.candidate.candidateId, CATCH_ALL);
    expect(res.body).toMatchObject({ status: "served", emailVerdict: "catch_all" });
    expect(fleet.enriched).toEqual([]);
  });

  it("a decline closes the re-reach; a valid-only reveal gives the person back", async () => {
    const id = await createAudience();
    await seedDroppedCatchAll(id, "p8");
    await seedDroppedCatchAll(id, "p9", new Date("2026-10-02T00:00:00Z"));
    mockApollo([[]]);
    const first = (await next(id, CATCH_ALL)).body.candidate;
    expect(first.providerPersonId).toBe("p8");
    expect((await decline(id, first.candidateId)).status).toBe(200);
    const [p8] = await db.select().from(catchAllRereaches).where(eq(catchAllRereaches.emailNorm, "p8@x.com"));
    expect(p8.status).toBe("declined");

    const second = (await next(id, CATCH_ALL)).body.candidate;
    expect(second.providerPersonId).toBe("p9");
    expect((await reveal(id, second.candidateId)).body).toMatchObject({
      status: "not_served", reason: "not_deliverable", verdict: "catch_all",
    });
    expect(
      await db.select().from(catchAllRereaches).where(and(eq(catchAllRereaches.emailNorm, "p9@x.com")))
    ).toHaveLength(0);
    // Re-reachable again for a caller asking for catch-all.
    const again = (await next(id, CATCH_ALL)).body.candidate;
    expect(again.providerPersonId).toBe("p9");
    expect((await reveal(id, again.candidateId, CATCH_ALL)).body).toMatchObject({ status: "served", emailVerdict: "catch_all" });
  });
});

describe("valid_catch_all_and_unknown (UNKNOWN-EMAILS-OPTION-1014)", () => {
  it("serve-next re-reaches dropped unknown AND catch-all people, each with their own verdict, no reveal", async () => {
    const id = await createAudience();
    await seedDroppedCatchAll(id, "u1", new Date("2026-10-01T00:00:00Z"), "unknown");
    await seedDroppedCatchAll(id, "c1", new Date("2026-10-02T00:00:00Z"));
    const fleet = mockApollo([[]]);

    const first = await serveNext(id, UNKNOWN);
    expect(first.body).toMatchObject({ status: "served", emailVerdict: "unknown" });
    expect(first.body.person).toMatchObject({ email: "u1@x.com", catchAll: null });
    const second = await serveNext(id, UNKNOWN);
    expect(second.body).toMatchObject({ status: "served", emailVerdict: "catch_all" });
    expect(second.body.person).toMatchObject({ email: "c1@x.com", catchAll: true });
    expect(fleet.enriched).toEqual([]);
    expect((await serveNext(id, UNKNOWN)).body).toMatchObject({ status: "exhausted" });
  });

  it("valid_and_catch_all never re-reaches an unknown person (today's behaviour)", async () => {
    const id = await createAudience();
    await seedDroppedCatchAll(id, "u1", undefined, "unknown");
    mockApollo([[]]);
    expect((await serveNext(id, CATCH_ALL)).body).toMatchObject({ status: "exhausted" });
    expect(await db.select().from(catchAllRereaches)).toHaveLength(0);
  });

  it("a later verdict on the address decides: unknown then valid-only-dropped invalid is never re-reached", async () => {
    const id = await createAudience();
    await seedDroppedCatchAll(id, "u1", undefined, "unknown");
    await db.insert(leadServes).values({
      orgId: ORG, brandId: BRAND, provider: "apollo", providerPersonId: "u1",
      email: "u1@x.com", audienceId: id, emailVerdict: "invalid", servedAt: new Date("2026-10-05T00:00:00Z"),
    });
    mockApollo([[]]);
    expect((await serveNext(id, UNKNOWN)).body).toMatchObject({ status: "exhausted" });
  });

  it("fresh reveal: unknown served under the option; invalid and risky never", async () => {
    const id = await createAudience();
    mockApollo([["p1", "p2", "p3"]], { p1: "unknown", p2: "invalid", p3: "risky" });
    const c1 = (await next(id, UNKNOWN)).body.candidate.candidateId;
    expect((await reveal(id, c1, UNKNOWN)).body).toMatchObject({ status: "served", emailVerdict: "unknown" });
    const [serve] = await db.select().from(leadServes);
    expect(serve.emailVerdict).toBe("unknown");
    for (const verdict of ["invalid", "risky"]) {
      const c = (await next(id, UNKNOWN)).body.candidate.candidateId;
      expect((await reveal(id, c, UNKNOWN)).body).toMatchObject({ status: "not_served", reason: "not_deliverable", verdict });
    }
  });

  it("candidates: a re-offered unknown person is handed only to a caller asking for unknown", async () => {
    const id = await createAudience();
    await seedDroppedCatchAll(id, "u1", undefined, "unknown");
    mockApollo([[]]);
    const offered = (await next(id, UNKNOWN)).body.candidate;
    expect(offered.providerPersonId).toBe("u1");
    expect((await reveal(id, offered.candidateId, CATCH_ALL)).body).toMatchObject({
      status: "not_served", reason: "not_deliverable", verdict: "unknown",
    });
    const again = (await next(id, UNKNOWN)).body.candidate;
    expect((await reveal(id, again.candidateId, UNKNOWN)).body).toMatchObject({ status: "served", emailVerdict: "unknown" });
  });
});

describe("openapi", () => {
  it("documents acceptedEmails and emailVerdict on the served routes", async () => {
    const res = await request(app).get("/openapi.json");
    const schemas = res.body.components.schemas;
    expect(schemas.ServeNextRequest.properties.acceptedEmails.enum).toEqual(["valid_only", "valid_and_catch_all", "valid_catch_all_and_unknown"]);
    expect(schemas.RevealCandidateRequest.properties.acceptedEmails.enum).toEqual(["valid_only", "valid_and_catch_all", "valid_catch_all_and_unknown"]);
    expect(schemas.ServeNextResponse.properties).toHaveProperty("emailVerdict");
    expect(schemas.RevealCandidateResponse.properties).toHaveProperty("emailVerdict");
  });
});
