import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

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
import {
  audienceCandidates,
  audiences,
  audienceScreenedOut,
  audienceTeaserScreenings,
  leadServes,
} from "../../src/db/schema.js";

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

async function createAudience(provider = "apollo") {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({
      name: `Chiros ${provider}`,
      brandId: BRAND,
      provider,
      filters: { personTitles: ["Chiropractor"] },
      ...(provider === "apollo" ? { apolloAudienceId: "apollo-aud-1" } : {}),
      nlPrompt: "Chiropractors who own their clinic",
      apolloCount: 100,
    });
  expect(res.status).toBe(201);
  const id = res.body.audience.id as string;
  await db
    .update(audiences)
    .set({ targetText: "Chiropractors who own their clinic" })
    .where(eq(audiences.id, id));
  return id;
}

const next = (id: string) =>
  request(app).post(`/orgs/audiences/${id}/candidates/next`).set(getAuthHeaders());
const reveal = (id: string, c: string, body: object = {}) =>
  request(app).post(`/orgs/audiences/${id}/candidates/${c}/reveal`).set(getAuthHeaders()).send(body);
const decline = (id: string, c: string, body: object = { reason: "site fast on mobile" }) =>
  request(app).post(`/orgs/audiences/${id}/candidates/${c}/decline`).set(getAuthHeaders()).send(body);

async function sizeOf(id: string): Promise<number> {
  const res = await request(app).get(`/orgs/audiences?brandId=${BRAND}`).set(getAuthHeaders());
  expect(res.status).toBe(200);
  return res.body.audiences.find((a: { id: string }) => a.id === id).sizeCount;
}

describe("candidate API — next", () => {
  it("hands out a free candidate with its company domain: no screen, no reveal", async () => {
    const id = await createAudience();
    const fleet = mockApollo([["p1", "p2"]]);
    const res = await next(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("candidate");
    expect(res.body.candidate.providerPersonId).toBe("p1");
    expect(res.body.candidate.company).toMatchObject({ name: "Org p1", domain: "p1.example", industry: "health" });
    expect(res.body.candidate.person).toMatchObject({ title: "Chiropractor p1", country: "Switzerland" });
    expect(res.body.target).toEqual({ text: "Chiropractors who own their clinic", field: "target_text" });
    expect(fleet.enriched).toEqual([]);
    expect(fleet.judged).toEqual([]);
    expect(await db.select().from(leadServes)).toHaveLength(0);
    // The next call offers someone else.
    const second = await next(id);
    expect(second.body.candidate.providerPersonId).toBe("p2");
  });

  it("answers exhausted when the provider has nobody new", async () => {
    const id = await createAudience();
    mockApollo([[]]);
    const res = await next(id);
    expect(res.body).toMatchObject({ status: "exhausted", candidate: null, reason: "pool_exhausted" });
  });

  it("re-offers an undecided candidate once its offer lapsed", async () => {
    const id = await createAudience();
    mockApollo([["p1", "p2"]]);
    const first = await next(id);
    await db
      .update(audienceCandidates)
      .set({ offeredAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(audienceCandidates.id, first.body.candidate.candidateId));
    const again = await next(id);
    expect(again.body.candidate.candidateId).toBe(first.body.candidate.candidateId);
  });

  it("refuses non-apollo audiences (serve-next keeps them)", async () => {
    const id = await createAudience("apify");
    mockApollo([]);
    const res = await next(id);
    expect(res.status).toBe(422);
  });

  it("404s another org's audience", async () => {
    mockApollo([]);
    const res = await request(app)
      .post(`/orgs/audiences/00000000-0000-4000-8000-00000000dead/candidates/next`)
      .set(getAuthHeaders());
    expect(res.status).toBe(404);
  });
});

describe("candidate API — reveal", () => {
  it("returns the served person shape, records the serve, and bills once", async () => {
    const id = await createAudience();
    const fleet = mockApollo([["p1"]]);
    const c = (await next(id)).body.candidate.candidateId as string;
    const res = await reveal(id, c, { basis: "criteria-v1" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("p1@x.com");
    expect(res.body.personId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.replayed).toBe(false);
    expect(fleet.enriched).toEqual(["p1"]);
    expect(await db.select().from(leadServes)).toHaveLength(1);

    const again = await reveal(id, c);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "served", replayed: true, personId: res.body.personId });
    expect(fleet.enriched).toEqual(["p1"]);
  });

  it("a revealed candidate cannot be declined, a declined one cannot be revealed", async () => {
    const id = await createAudience();
    mockApollo([["p1", "p2"]]);
    const c1 = (await next(id)).body.candidate.candidateId as string;
    await reveal(id, c1);
    expect((await decline(id, c1)).status).toBe(409);
    const c2 = (await next(id)).body.candidate.candidateId as string;
    await decline(id, c2);
    expect((await reveal(id, c2)).status).toBe(409);
  });

  it("a provider failure records nothing and the candidate can be revealed again", async () => {
    const id = await createAudience();
    mockApollo([["p1"]]);
    const c = (await next(id)).body.candidate.candidateId as string;
    const base = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) =>
      String(url).endsWith("/enrich")
        ? { ok: false, status: 500, text: async () => "down", json: async () => ({}) }
        : base(url, init)
    );
    expect((await reveal(id, c)).status).toBe(502);
    fetchSpy.mockImplementation(base);
    const res = await reveal(id, c);
    expect(res.body.status).toBe("served");
  });
});

describe("candidate API — reveal names why nobody was served", () => {
  async function revealWith(enrichBody: (id: string) => unknown) {
    const id = await createAudience();
    mockApollo([["p1"]]);
    const base = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) =>
      String(url).endsWith("/enrich")
        ? ok(enrichBody(JSON.parse(init.body ?? "{}").apolloPersonId))
        : base(url, init)
    );
    const c = (await next(id)).body.candidate.candidateId as string;
    const res = await reveal(id, c);
    expect(res.status).toBe(200);
    return res.body;
  }

  it("provider_skipped when apollo-service declined to buy the reveal", async () => {
    const body = await revealWith(() => ({
      person: null,
      emailVerification: null,
      revealSkipped: { skipId: "s1", reason: "catch_all_domain" },
    }));
    expect(body).toMatchObject({ status: "not_served", reason: "provider_skipped", detail: "catch_all_domain" });
  });

  it("no_person when the provider returned nobody", async () => {
    const body = await revealWith(() => ({ person: null }));
    expect(body).toMatchObject({ status: "not_served", reason: "no_person" });
  });

  it("no_email when the reveal carried no address", async () => {
    const body = await revealWith((id) => ({ person: { ...teaser(id, "Chiropractor"), lastName: "D", email: null } }));
    expect(body).toMatchObject({ status: "not_served", reason: "no_email" });
  });

  it("not_deliverable with the verdict when the address failed verification", async () => {
    const body = await revealWith((id) => ({
      person: { ...teaser(id, "Chiropractor"), lastName: "D", email: "catch@all.example", emailStatus: "verified" },
      emailVerification: { verdict: "catch_all", deliverable: false },
    }));
    expect(body).toMatchObject({ status: "not_served", reason: "not_deliverable", verdict: "catch_all" });
  });

  it("the stored answer replays the reason", async () => {
    const id = await createAudience();
    mockApollo([["p1"]]);
    const base = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) =>
      String(url).endsWith("/enrich") ? ok({ person: null }) : base(url, init)
    );
    const c = (await next(id)).body.candidate.candidateId as string;
    await reveal(id, c);
    expect((await reveal(id, c)).body).toMatchObject({ reason: "no_person", replayed: true });
  });
});

describe("candidate API — decline", () => {
  it("never offers the person again for that audience and shrinks Size by one", async () => {
    const id = await createAudience();
    // p1 resurfaces on the second page after being declined.
    mockApollo([["p1"], ["p1", "p2"]]);
    expect(await sizeOf(id)).toBe(100);
    const c = (await next(id)).body.candidate.candidateId as string;
    const res = await decline(id, c, { reason: "no careers page", basis: "criteria-v1" });
    expect(res.body).toEqual({ declined: true, replayed: false });
    expect((await decline(id, c)).body).toEqual({ declined: true, replayed: true });
    expect(await sizeOf(id)).toBe(99);
    const out = await db.select().from(audienceScreenedOut);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("declined: no careers page");
    const after = await next(id);
    expect(after.body.candidate.providerPersonId).toBe("p2");
  });

  it("serve-next never serves a person declined for that audience", async () => {
    const id = await createAudience();
    const fleet = mockApollo([["p1"], ["p1"], []]);
    const c = (await next(id)).body.candidate.candidateId as string;
    await decline(id, c);
    const res = await request(app).post(`/orgs/audiences/${id}/serve-next`).set(getAuthHeaders());
    expect(res.body.status).toBe("exhausted");
    expect(fleet.enriched).toEqual([]);
  });

  it("400s a decline without a reason", async () => {
    const id = await createAudience();
    mockApollo([["p1"]]);
    const c = (await next(id)).body.candidate.candidateId as string;
    expect((await decline(id, c, {})).status).toBe(400);
  });
});

describe("candidate API — yield", () => {
  it("is exhausted once 1,000 decisions under the latest basis hold fewer than 3 reveals", async () => {
    const id = await createAudience();
    mockApollo([["fresh"]]);
    const now = Date.now();
    await db.insert(audienceCandidates).values(
      Array.from({ length: 1000 }, (_, i) => ({
        orgId: ORG,
        audienceId: id,
        providerPersonId: `old-${i}`,
        status: (i < 2 ? "revealed" : "declined") as "revealed" | "declined",
        basis: "criteria-v1",
        decidedAt: new Date(now - i * 1000),
      }))
    );
    const res = await next(id);
    expect(res.body).toMatchObject({ status: "exhausted", reason: "yield_exhausted" });
    // A new basis starts a new window.
    await db.insert(audienceCandidates).values({
      orgId: ORG,
      audienceId: id,
      providerPersonId: "new-basis",
      status: "declined",
      basis: "criteria-v2",
      decidedAt: new Date(now + 1000),
    });
    expect((await next(id)).body.status).toBe("candidate");
  });
});

describe("GET /orgs/audiences/{id}/screenings", () => {
  it("returns every past verdict, oldest first, paginated", async () => {
    const id = await createAudience();
    const snap = { name: "C", title: "Chiro", headline: null, seniority: null, city: null, state: null, country: null, organizationName: "Org", organizationIndustry: null, organizationEmployees: null, organizationCity: null, organizationState: null, organizationCountry: null, organizationKeywords: null };
    for (const [i, verdict] of [true, false, true].entries()) {
      await db.insert(audienceTeaserScreenings).values({
        orgId: ORG,
        audienceId: id,
        providerPersonId: `s${i}`,
        teaser: snap,
        verdict,
        yesProbability: verdict ? 0.9 : 0.1,
        reason: "P(yes)=0.9 threshold>0.5",
        model: "typesafe/jev",
        promptVersion: "v2",
        targetText: "Chiropractors",
        targetField: "target_text",
        createdAt: new Date(Date.now() + i * 1000),
      });
    }
    const page = await request(app).get(`/orgs/audiences/${id}/screenings?limit=2`).set(getAuthHeaders());
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(3);
    expect(page.body.screenings.map((s: { providerPersonId: string }) => s.providerPersonId)).toEqual(["s0", "s1"]);
    expect(page.body.screenings[1]).toMatchObject({ verdict: false, yesProbability: 0.1, promptVersion: "v2" });
    const rest = await request(app).get(`/orgs/audiences/${id}/screenings?limit=2&offset=2`).set(getAuthHeaders());
    expect(rest.body.screenings.map((s: { providerPersonId: string }) => s.providerPersonId)).toEqual(["s2"]);
    const one = await request(app).get(`/orgs/audiences/${id}/screenings?providerPersonId=s1`).set(getAuthHeaders());
    expect(one.body.total).toBe(1);
  });
});
