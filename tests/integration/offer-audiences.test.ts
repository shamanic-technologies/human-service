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
import { audienceCandidates, audiences, audienceTeaserBuffer, leadServes } from "../../src/db/schema.js";

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

const OFFER_A = "00000000-0000-4000-8000-0000000000a1";
const OFFER_B = "00000000-0000-4000-8000-0000000000b1";

async function createSearch(name = "US Chiropractors") {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({
      name,
      brandId: BRAND,
      offerId: OFFER_A,
      provider: "apollo",
      filters: { personTitles: ["Chiropractor"] },
      apolloAudienceId: "apollo-aud-1",
      nlPrompt: "Chiropractors in the US",
      apolloCount: 100,
    });
  expect(res.status).toBe(201);
  return res.body.audience.id as string;
}

const realign = (searchAudienceIds: string[], dryRun = false) =>
  request(app)
    .post(`/internal/offer-audiences/realign${dryRun ? "?dryRun=true" : ""}`)
    .set(getAuthHeaders())
    .send({
      reason: "test-realign",
      orgId: ORG,
      brandId: BRAND,
      offers: [
        { offerId: OFFER_A, name: "Chiro owners & co", text: "Chiropractors who own their practice" },
        { offerId: OFFER_B, name: "Chiro employees & co", text: "Employed chiropractors" },
      ],
      searchAudienceIds,
    });

async function targets(): Promise<{ a: string; b: string }> {
  const rows = await db.select().from(audiences).where(eq(audiences.role, "target"));
  return {
    a: rows.find((r) => r.offerId === OFFER_A)!.id,
    b: rows.find((r) => r.offerId === OFFER_B)!.id,
  };
}

const next = (id: string) =>
  request(app).post(`/orgs/audiences/${id}/candidates/next`).set(getAuthHeaders());
const reveal = (id: string, c: string) =>
  request(app).post(`/orgs/audiences/${id}/candidates/${c}/reveal`).set(getAuthHeaders()).send({});
const decline = (id: string, c: string) =>
  request(app).post(`/orgs/audiences/${id}/candidates/${c}/decline`).set(getAuthHeaders()).send({ reason: "not an owner" });

describe("offer audiences — realignment", () => {
  it("dry run writes nothing; the run creates one audience per offer and turns the rows into brand lists", async () => {
    const search = await createSearch();
    const dry = await realign([search], true);
    expect(dry.status).toBe(200);
    expect(dry.body.targets.map((t: { outcome: string }) => t.outcome)).toEqual(["would_create", "would_create"]);
    expect(dry.body.searches).toEqual([{ audienceId: search, outcome: "would_make_search" }]);
    expect(await db.select().from(audiences).where(eq(audiences.role, "target"))).toHaveLength(0);

    const res = await realign([search]);
    expect(res.status).toBe(200);
    expect(res.body.targets.map((t: { outcome: string }) => t.outcome)).toEqual(["created", "created"]);
    const { a } = await targets();
    const [rowA] = await db.select().from(audiences).where(eq(audiences.id, a));
    expect(rowA).toMatchObject({ nlPrompt: "Chiropractors who own their practice", targetText: "Chiropractors who own their practice", status: "active" });

    // The list shows offer audiences, never the brand's lists unless asked.
    const list = await request(app).get(`/orgs/audiences?brandId=${BRAND}&status=active`).set(getAuthHeaders());
    expect(list.body.audiences.map((x: { id: string }) => x.id).sort()).toEqual(Object.values(await targets()).sort());
    expect(list.body.audiences[0].role).toBe("target");
    expect(list.body.audiences[0].sizeCount).toBeUndefined();
    const lists = await request(app).get(`/orgs/audiences?brandId=${BRAND}&role=search`).set(getAuthHeaders());
    expect(lists.body.audiences.map((x: { id: string }) => x.id)).toEqual([search]);

    // Idempotent.
    const again = await realign([search]);
    expect(again.body.targets.map((t: { outcome: string }) => t.outcome)).toEqual(["exists", "exists"]);
    expect(again.body.searches[0].outcome).toBe("already_search");

    // Reversible.
    const rev = await request(app).post("/internal/offer-audiences/realign/revert").set(getAuthHeaders()).send({ reason: "test-realign" });
    expect(rev.body).toEqual({ restoredSearches: 1, deprecatedTargets: 2 });
    const [restored] = await db.select().from(audiences).where(eq(audiences.id, search));
    expect(restored.role).toBeNull();
    const after = await request(app).get(`/orgs/audiences?brandId=${BRAND}`).set(getAuthHeaders());
    expect(after.body.audiences.map((x: { id: string }) => x.id)).toEqual([search]);
  });

  it("404s a row of another brand", async () => {
    const res = await realign(["00000000-0000-4000-8000-00000000dead"]);
    expect(res.status).toBe(404);
  });
});

describe("offer audiences — the shared walk", () => {
  it("an offer audience walks the brand's list and records which list found the person", async () => {
    const search = await createSearch();
    await realign([search]);
    const { a } = await targets();
    const fleet = mockApollo([["p1", "p2"]]);
    const res = await next(a);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("candidate");
    expect(res.body.candidate).toMatchObject({ audienceId: a, providerPersonId: "p1" });
    expect(res.body.target).toEqual({ text: "Chiropractors who own their practice", field: "target_text" });
    const [row] = await db.select().from(audienceCandidates).where(eq(audienceCandidates.id, res.body.candidate.candidateId));
    expect(row.searchAudienceId).toBe(search);
    expect(fleet.enriched).toEqual([]);
  });

  it("a person one offer declines is offered to the other offer, without a second search", async () => {
    const search = await createSearch();
    await realign([search]);
    const { a, b } = await targets();
    let searches = 0;
    mockApollo([["p1"]]);
    const base = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      if (String(url).endsWith("/search/next")) searches += 1;
      return base(url, init);
    });
    const ca = (await next(a)).body.candidate.candidateId as string;
    expect((await decline(a, ca)).status).toBe(200);
    // Offer A has seen p1: nothing more for it.
    expect((await next(a)).body).toMatchObject({ status: "exhausted", reason: "pool_exhausted" });
    // Offer B still gets p1 from the same buffered page.
    const forB = await next(b);
    expect(forB.body.status).toBe("candidate");
    expect(forB.body.candidate.providerPersonId).toBe("p1");
    expect(searches).toBe(2); // the first page, then A asking for more
  });

  it("a person one offer revealed is never offered to the other, and leaves the list", async () => {
    const search = await createSearch();
    await realign([search]);
    const { a, b } = await targets();
    const fleet = mockApollo([["p1"]]);
    const ca = (await next(a)).body.candidate.candidateId as string;
    const r = await reveal(a, ca);
    expect(r.body.status).toBe("served");
    expect(fleet.enriched).toEqual(["p1"]);
    expect((await next(b)).body).toMatchObject({ status: "exhausted" });
    expect(await db.select().from(audienceTeaserBuffer)).toHaveLength(0);
    expect(await db.select().from(leadServes)).toHaveLength(1);
  });

  it("serve-next refuses an offer audience (it is served through candidates)", async () => {
    const search = await createSearch();
    await realign([search]);
    const { a } = await targets();
    mockApollo([]);
    const res = await request(app).post(`/orgs/audiences/${a}/serve-next`).set(getAuthHeaders()).send({});
    expect(res.status).toBe(422);
  });

  it("a brand list no offer audience walks keeps serving its own candidates (unchanged)", async () => {
    const plain = await createSearch("Plain list");
    mockApollo([["p1"]]);
    const res = await next(plain);
    expect(res.body.status).toBe("candidate");
    const [row] = await db.select().from(audienceCandidates).where(eq(audienceCandidates.id, res.body.candidate.candidateId));
    expect(row.searchAudienceId).toBeNull();
  });
});

describe("offer audiences — CRM lists through hand-outs", () => {
  async function crmSearch() {
    const [row] = await db
      .insert(audiences)
      .values({ orgId: ORG, brandId: BRAND, offerId: OFFER_A, name: "CRM contacts", provider: "crm", status: "active" })
      .returning();
    return row.id;
  }

  // crm-service hand-outs: one contact X; each asker gets X once; served = burned for every asker.
  function mockCrm() {
    const handed = new Map<string, string>(); // handOutId -> asker
    const declined: string[] = [];
    const served: string[] = [];
    let burned = false;
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      if (u.endsWith("/orgs/contacts/hand-outs")) {
        const asker = body.asker as string;
        const already = [...handed.values()].includes(asker);
        if (burned || already) return ok({ asker, contacts: [], handedOut: 0, exhausted: true });
        const handOutId = `00000000-0000-4000-8000-00000000${String(handed.size + 1).padStart(4, "0")}`;
        handed.set(handOutId, asker);
        return ok({
          asker,
          contacts: [{ id: "c-x", handOutId, primaryEmail: "x@clinic.com", phoneE164: null, fullName: "X Doe", firstName: "X", lastName: "Doe", jobTitle: "Associate Chiropractor", companyName: "Clinic" }],
          handedOut: 1,
          exhausted: false,
        });
      }
      const m = u.match(/hand-outs\/([^/]+)\/(serve|decline)$/);
      if (m) {
        if (m[2] === "decline") {
          declined.push(handed.get(m[1])!);
          return ok({ handOutId: m[1], status: "declined", duplicate: false, emails: [] });
        }
        if (burned) return { ok: false, status: 409, json: async () => ({ type: "already_served" }), text: async () => "" };
        burned = true;
        served.push(handed.get(m[1])!);
        return ok({ handOutId: m[1], status: "served", duplicate: false, emails: ["x@clinic.com"] });
      }
      throw new Error("unexpected url " + u);
    });
    return { declined, served };
  }

  beforeEach(() => {
    process.env.CRM_SERVICE_URL = "http://crm:8080";
    process.env.CRM_SERVICE_API_KEY = "crm-key";
  });

  it("a CRM contact one offer declines goes to the other offer, burned only when that one serves it", async () => {
    const crm = await crmSearch();
    await realign([crm]);
    const { a, b } = await targets();
    const fleet = mockCrm();
    const forA = await next(a);
    expect(forA.body.status).toBe("candidate");
    expect(forA.body.candidate.providerPersonId).toBe("c-x");
    expect((await decline(a, forA.body.candidate.candidateId)).status).toBe(200);
    expect(fleet.declined).toEqual([`audience:${a}`]);
    expect((await next(a)).body.status).toBe("exhausted");

    const forB = await next(b);
    expect(forB.body.candidate.providerPersonId).toBe("c-x");
    const r = await reveal(b, forB.body.candidate.candidateId);
    expect(r.body).toMatchObject({ status: "served" });
    expect(r.body.person.email).toBe("x@clinic.com");
    expect(fleet.served).toEqual([`audience:${b}`]);
  });

  it("a hand-out another offer served first is never written to", async () => {
    const crm = await crmSearch();
    await realign([crm]);
    const { a, b } = await targets();
    mockCrm();
    const forA = (await next(a)).body.candidate.candidateId as string;
    const forB = (await next(b)).body.candidate.candidateId as string;
    expect((await reveal(a, forA)).body.status).toBe("served");
    const second = await reveal(b, forB);
    expect(second.body).toMatchObject({ status: "not_served", reason: "already_served" });
  });
});
