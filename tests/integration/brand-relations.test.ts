import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// OUTREACH-3WAYS-1121: a brand's investors and industry peers, served like any audience.

vi.mock("../../src/lib/email-verification.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readEmailVerification: (_p: string, _raw: unknown, email: string | null | undefined) =>
      email ? { verdict: "valid", deliverable: true } : null,
  };
});
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
vi.mock("../../src/services/audience-refill.js", () => ({
  runAudienceRefillSweep: vi.fn(async () => ({})),
}));
vi.mock("../../src/lib/brand-identity.js", () => ({
  getBrandIdentity: async (brandId: string) => ({ id: brandId, domain: "acme.test", url: null, name: "Acme", salesRepEmail: null }),
}));
const competitors = vi.hoisted(() => ({
  answer: { status: "computed", competitors: [{ name: "Rival", domain: "rival.test", linkedinUrl: null }] } as Record<string, unknown>,
}));
vi.mock("../../src/lib/brand-competitors.js", () => ({
  discoverBrandCompetitors: vi.fn(async () => competitors.answer),
}));
vi.mock("../../src/services/runs.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, createRun: vi.fn(async () => "00000000-0000-4000-8000-0000000000e2"), completeRun: vi.fn(async () => undefined) };
});
vi.mock("../../src/lib/brand-offers.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listBrandOffers: vi.fn(async (brandId: string) => [
      { offerId: "00000000-0000-4000-8000-0000000000d2", brandId, name: "Outbound", description: "Done-for-you B2B sales outreach that books sales meetings" },
    ]),
  };
});
// Jev (chat-service): every judgment recorded; the answer read from the per-test table, by company or person.
const jev = vi.hoisted(() => ({ calls: [] as Array<{ state: Record<string, unknown>; instructions: string }>, p: {} as Record<string, number> }));
vi.mock("../../src/lib/chat-client.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    judgeYesNo: vi.fn(async (args: { state: Record<string, unknown>; instructions: string }) => {
      jev.calls.push(args);
      const subject = (args.state.company ?? args.state.person) as Record<string, unknown>;
      const key = String((subject.domain ?? subject.title ?? "") as string);
      return { yesProbability: jev.p[key] ?? 0.9, model: "typesafe/test" };
    }),
  };
});
// The list's Apollo filters are the shared pointer build (its own suites): recorded, not run.
const builds = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("../../src/services/audiences.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ensureApolloPointer: vi.fn(async (row: { id: string }) => {
      builds.ids.push(row.id);
      return row;
    }),
  };
});

import request from "supertest";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audienceCandidates, audiences, audienceTeaserBuffer, relationFitJudgments } from "../../src/db/schema.js";

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000c2";
const ORG = getAuthHeaders()["x-org-id"];
const ANGEL_OFFER = "00000000-0000-4000-8000-0000000000a2";
const PRODUCT_OFFER = "00000000-0000-4000-8000-0000000000b2";

const fetchSpy = vi.fn();
const fetchBeforeThisSuite = globalThis.fetch;

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  builds.ids = [];
  jev.calls = [];
  jev.p = {};
  (await import("../../src/services/relation-fit.js")).clearRelationFitCaches();
  competitors.answer = { status: "computed", competitors: [{ name: "Rival", domain: "rival.test", linkedinUrl: null }] };
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

function teaser(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    firstName: "C",
    lastName: null,
    name: null,
    email: null,
    emailStatus: null,
    title: "Angel Investor",
    headline: null,
    seniority: "owner",
    linkedinUrl: `linkedin.com/in/${id}`,
    photoUrl: null,
    city: null,
    state: null,
    country: "United States",
    organizationName: `Fund ${id}`,
    organizationDomain: `${id}.vc`,
    organizationWebsiteUrl: null,
    organizationIndustry: "venture capital",
    organizationSize: null,
    organizationLinkedinUrl: null,
    organizationLogoUrl: null,
    organizationCity: null,
    organizationState: null,
    organizationCountry: null,
    ...over,
  };
}

/** Apollo answers each search with one page per list, keyed by the list's own filters. */
function mockApollo(byTitle: Record<string, string[]>) {
  const searchedTitles: string[] = [];
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/search/next")) {
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      const title = JSON.stringify(body).match(/"(Angel|Chiropractor)"/)?.[1] ?? "none";
      searchedTitles.push(title);
      const people = (byTitle[title] ?? []).map(teaser);
      byTitle[title] = [];
      return ok({ people, done: people.length === 0, totalEntries: people.length });
    }
    throw new Error("unexpected url " + u);
  });
  return { searchedTitles };
}

async function createList(name: string, offerId: string, title: string, apolloCount: number) {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({ name, brandId: BRAND, offerId, provider: "apollo", filters: { person_titles: [title] }, apolloAudienceId: `apollo-${name}`, nlPrompt: name, apolloCount });
  expect(res.status).toBe(201);
  return res.body.audience.id as string;
}

/** distribute.you's shape before this change: angel lists + an Angels target on an (archived) offer, beside buyer lists. */
async function seedAngelsOnAnOffer() {
  const angels = await createList("US Angels", ANGEL_OFFER, "Angel", 155);
  const buyers = await createList("US Chiropractors", PRODUCT_OFFER, "Chiropractor", 900);
  const realign = await request(app)
    .post("/internal/offer-audiences/realign")
    .set(getAuthHeaders())
    .send({
      reason: "seed",
      orgId: ORG,
      brandId: BRAND,
      offers: [
        { offerId: ANGEL_OFFER, name: "Angels", text: "Business angels who invest in B2B startups" },
        { offerId: PRODUCT_OFFER, name: "Product", text: "Chiropractors who own their practice" },
      ],
      searchAudienceIds: [angels, buyers],
    });
  expect(realign.status).toBe(200);
  const targets = await db.select().from(audiences).where(eq(audiences.role, "target"));
  return {
    angels,
    buyers,
    angelTarget: targets.find((t) => t.offerId === ANGEL_OFFER)!.id,
    productTarget: targets.find((t) => t.offerId === PRODUCT_OFFER)!.id,
  };
}

const assign = (body: Record<string, unknown>, dryRun = false) =>
  request(app)
    .post(`/internal/brand-relations/assign${dryRun ? "?dryRun=true" : ""}`)
    .set(getAuthHeaders())
    .send({ reason: "investors-1121", orgId: ORG, brandId: BRAND, relation: "investors", searchAudienceIds: [], ...body });

const relations = () => request(app).get(`/orgs/audiences/relations?brandId=${BRAND}`).set(getAuthHeaders());

describe("brand relations — adopting existing audiences", () => {
  it("the investors' target and lists become the brand's investors, listed by the relations read", async () => {
    const s = await seedAngelsOnAnOffer();
    const dry = await assign({ targetAudienceId: s.angelTarget, searchAudienceIds: [s.angels] }, true);
    expect(dry.status).toBe(200);
    expect(dry.body.assigned.map((a: { outcome: string }) => a.outcome)).toEqual(["would_assign", "would_assign"]);
    expect((await relations()).body.relations[0].audienceId).toBeNull();

    const res = await assign({ targetAudienceId: s.angelTarget, searchAudienceIds: [s.angels] });
    expect(res.status).toBe(200);
    const [target] = await db.select().from(audiences).where(eq(audiences.id, s.angelTarget));
    expect(target).toMatchObject({ relation: "investors", offerId: null, role: "target" });

    const read = await relations();
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      brandId: BRAND,
      relations: [
        {
          relation: "investors",
          audienceId: s.angelTarget,
          name: "Angels",
          status: "active",
          targetText: "Business angels who invest in B2B startups",
          reachableCount: 155,
          lists: [{ audienceId: s.angels, name: "US Angels", status: "active", provider: "apollo", sizeCount: 155, availableToContactCount: 155 }],
        },
        { relation: "industry_peers", audienceId: null, name: null, status: null, targetText: null, reachableCount: null, lists: [] },
      ],
    });

    // The audience list carries the relation and narrows on it.
    const list = await request(app).get(`/orgs/audiences?brandId=${BRAND}&relation=investors`).set(getAuthHeaders());
    expect(list.body.audiences.map((a: { id: string; relation: string }) => [a.id, a.relation])).toEqual([[s.angelTarget, "investors"]]);

    // Idempotent, and reversible verbatim.
    expect((await assign({ targetAudienceId: s.angelTarget, searchAudienceIds: [s.angels] })).body.assigned.map((a: { outcome: string }) => a.outcome)).toEqual([
      "already",
      "already",
    ]);
    const rev = await request(app).post("/internal/brand-relations/revert").set(getAuthHeaders()).send({ reason: "investors-1121" });
    expect(rev.body).toEqual({ restored: 2, deprecated: 0 });
    const [back] = await db.select().from(audiences).where(eq(audiences.id, s.angels));
    expect(back).toMatchObject({ relation: null, offerId: ANGEL_OFFER, role: "search" });
  });

  it("the investors' audience walks only its own lists; an offer's audience never walks them", async () => {
    const s = await seedAngelsOnAnOffer();
    await assign({ targetAudienceId: s.angelTarget, searchAudienceIds: [s.angels] });

    const apollo = mockApollo({ Angel: ["a1"], Chiropractor: ["c1"] });
    const inv = await request(app).post(`/orgs/audiences/${s.angelTarget}/candidates/next`).set(getAuthHeaders());
    expect(inv.status).toBe(200);
    expect(inv.body.candidate).toMatchObject({ audienceId: s.angelTarget, providerPersonId: "a1" });
    expect(inv.body.target.text).toBe("Business angels who invest in B2B startups");
    const [row] = await db.select().from(audienceCandidates).where(eq(audienceCandidates.id, inv.body.candidate.candidateId));
    expect(row.searchAudienceId).toBe(s.angels);
    expect(apollo.searchedTitles).toEqual(["Angel"]);

    const buyer = await request(app).post(`/orgs/audiences/${s.productTarget}/candidates/next`).set(getAuthHeaders());
    expect(buyer.body.candidate).toMatchObject({ audienceId: s.productTarget, providerPersonId: "c1" });
    expect(apollo.searchedTitles).toEqual(["Angel", "Chiropractor"]);
  });

  it("refuses a second target for a relation the brand already has", async () => {
    const s = await seedAngelsOnAnOffer();
    await assign({ targetAudienceId: s.angelTarget });
    const res = await assign({ reason: "other", targetAudienceId: s.productTarget });
    expect(res.status).toBe(409);
  });
});

describe("brand relations — built for the brand", () => {
  it("ensure builds the investors and the industry peers from the brand and its competitors, once", async () => {
    const res = await request(app).post("/orgs/audiences/relations/ensure").set(getAuthHeaders()).send({ brandId: BRAND });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { relation: string; target: string; list: string }) => [r.relation, r.target, r.list])).toEqual([
      ["investors", "created", "created"],
      ["industry_peers", "created", "created"],
    ]);
    const peers = res.body.results[1];
    const [peerTarget] = await db.select().from(audiences).where(eq(audiences.id, peers.audienceId));
    expect(peerTarget).toMatchObject({ role: "target", relation: "industry_peers", offerId: null, status: "active", name: "Industry peers" });
    expect(peerTarget.targetText).toContain("Rival (rival.test)");
    expect(peerTarget.targetText).toContain("Acme (acme.test)");
    const [peerList] = await db.select().from(audiences).where(eq(audiences.id, peers.listAudienceId));
    expect(peerList).toMatchObject({ role: "search", relation: "industry_peers", provider: "apollo", apolloAudienceId: null });
    expect(peerList.description).toContain("Rival (rival.test)");
    expect(builds.ids.sort()).toEqual([res.body.results[0].listAudienceId, peers.listAudienceId].sort());

    // Listed, the lists not measured until their Apollo filters land.
    const read = await relations();
    expect(read.body.relations[1]).toMatchObject({ relation: "industry_peers", audienceId: peers.audienceId, reachableCount: null });
    expect(read.body.relations[1].lists[0]).toMatchObject({ audienceId: peers.listAudienceId, sizeCount: null });

    const again = await request(app).post("/orgs/audiences/relations/ensure").set(getAuthHeaders()).send({ brandId: BRAND });
    expect(again.body.results.map((r: { target: string; list: string }) => [r.target, r.list])).toEqual([
      ["exists", "exists"],
      ["exists", "exists"],
    ]);
    expect(builds.ids).toHaveLength(2);
  });

  it("industry peers wait for the brand's competitors; never invented", async () => {
    competitors.answer = { status: "not_computed", reason: "later" };
    const res = await request(app)
      .post("/orgs/audiences/relations/ensure")
      .set(getAuthHeaders())
      .send({ brandId: BRAND, relations: ["industry_peers"] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { relation: "industry_peers", target: "skipped", list: "skipped", reason: "competitors_not_computed", audienceId: null, listAudienceId: null },
    ]);
    expect(await db.select().from(audiences)).toHaveLength(0);
  });

  it("an offer is never attributed to a relation audience by the offer sweep", async () => {
    await request(app).post("/orgs/audiences/relations/ensure").set(getAuthHeaders()).send({ brandId: BRAND, relations: ["investors"] });
    const { loadOfferlessPairs } = await import("../../src/services/audience-offer-backfill.js");
    const pairs = await loadOfferlessPairs();
    expect(pairs.pairs).toEqual([]);
  });
});

describe("brand relations — only people in the relation are offered (judged once, persisted)", () => {
  async function ensureWithList(relation: "industry_peers" | "investors") {
    const res = await request(app).post("/orgs/audiences/relations/ensure").set(getAuthHeaders()).send({ brandId: BRAND, relations: [relation] });
    expect(res.status).toBe(200);
    const { audienceId, listAudienceId } = res.body.results[0];
    // The pointer build is mocked: give the list its Apollo filters as the build would.
    await db.update(audiences).set({ filters: { person_titles: ["Founder"] }, apolloAudienceId: `apollo-${relation}` }).where(eq(audiences.id, listAudienceId));
    return { target: audienceId as string, list: listAudienceId as string };
  }

  function mockPages(pages: Array<Array<ReturnType<typeof teaser>>>) {
    let searches = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/search/next")) {
        const people = pages[searches] ?? [];
        searches += 1;
        return ok({ people, done: people.length === 0, totalEntries: people.length });
      }
      throw new Error("unexpected url " + u);
    });
    return { searches: () => searches };
  }

  const nextgen = (id: string) =>
    teaser(id, { title: "Director of Product, Patient Experience Platform", organizationName: "NextGen Healthcare", organizationDomain: "nextgen.com", organizationIndustry: "hospital & health care" });
  const salesloft = (id: string) =>
    teaser(id, { title: "VP Sales", organizationName: "Salesloft", organizationDomain: "salesloft.com", organizationIndustry: "computer software" });

  it("industry peers: a company outside the brand's industry is never offered; each company is judged once", async () => {
    const { target, list } = await ensureWithList("industry_peers");
    jev.p["nextgen.com"] = 0.1;
    mockPages([[nextgen("n1"), nextgen("n2")], [salesloft("s1")]]);

    const res = await request(app).post(`/orgs/audiences/${target}/candidates/next`).set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.candidate).toMatchObject({ audienceId: target, providerPersonId: "s1" });

    // One question per COMPANY: NextGen once for its two people, Salesloft once.
    expect(jev.calls).toHaveLength(2);
    const asked = jev.calls[0]!;
    expect(asked.state.company).toMatchObject({ name: "NextGen Healthcare", domain: "nextgen.com", industry: "hospital & health care" });
    expect(asked.state.company).not.toHaveProperty("title");
    expect(JSON.stringify(asked.state.brand)).toContain("Done-for-you B2B sales outreach");
    expect(asked.instructions).toContain("You judge ONE company");

    const judgments = await db.select().from(relationFitJudgments);
    expect(judgments.map((j) => [j.subjectKey, j.verdict]).sort()).toEqual([
      ["company:domain:nextgen.com", false],
      ["company:domain:salesloft.com", true],
    ]);
    // The NextGen people left the list's buffer; nobody of theirs can be offered.
    const buffered = await db.select().from(audienceTeaserBuffer).where(eq(audienceTeaserBuffer.audienceId, list));
    expect(buffered.map((b) => b.providerPersonId)).toEqual(["s1"]);
    const offered = await db.select().from(audienceCandidates).where(eq(audienceCandidates.audienceId, target));
    expect(offered.map((c) => c.providerPersonId)).toEqual(["s1"]);
  });

  it("investors: judged per PERSON, someone who only works at a fund-shaped name is never offered", async () => {
    const { target } = await ensureWithList("investors");
    jev.p["Fund Accountant"] = 0.2;
    mockPages([[teaser("f1", { title: "Fund Accountant", organizationName: "Seed Capital Partners" })], [teaser("a1")]]);

    const res = await request(app).post(`/orgs/audiences/${target}/candidates/next`).set(getAuthHeaders());
    expect(res.body.candidate).toMatchObject({ providerPersonId: "a1" });
    expect(jev.calls.map((c) => (c.state.person as { title: string }).title)).toEqual(["Fund Accountant", "Angel Investor"]);
    expect(jev.calls[0]!.instructions).toContain("invests equity in companies themselves");
    const keys = (await db.select().from(relationFitJudgments)).map((j) => j.subjectKey).sort();
    expect(keys).toEqual(["person:a1", "person:f1"]);
  });

  it("the relation screen judges the whole list ahead of the walk and reports how many pass; the walk reuses its verdicts", async () => {
    const { target } = await ensureWithList("industry_peers");
    jev.p["nextgen.com"] = 0.1;
    const apollo = mockPages([[nextgen("n1"), salesloft("s1")], [nextgen("n2")]]);

    const screen = await request(app)
      .post("/internal/brand-relations/screen")
      .set(getAuthHeaders())
      .send({ orgId: ORG, brandId: BRAND, relation: "industry_peers" });
    expect(screen.body.error ?? null).toBeNull();
    expect(screen.status).toBe(200);
    expect(screen.body).toMatchObject({ audienceId: target, people: 3, judged: 3, passed: 1, failed: 2, noFacts: 0, unjudged: 0, subjects: 2, passedSubjects: 1 });
    expect(screen.body.lists[0]).toMatchObject({ pagesSearched: 3, buffered: 3 });
    expect(screen.body.passedSample.map((p: { company: string }) => p.company)).toEqual(["Salesloft"]);
    expect(jev.calls).toHaveLength(2);
    expect(apollo.searches()).toBe(3);

    const dry = await request(app)
      .post("/internal/brand-relations/screen?dryRun=true")
      .set(getAuthHeaders())
      .send({ orgId: ORG, brandId: BRAND, relation: "industry_peers" });
    expect(dry.body).toMatchObject({ dryRun: true, people: 3, passed: 1, failed: 2, unjudged: 0 });
    expect(apollo.searches()).toBe(3);

    const res = await request(app).post(`/orgs/audiences/${target}/candidates/next`).set(getAuthHeaders());
    expect(res.body.candidate).toMatchObject({ providerPersonId: "s1" });
    expect(jev.calls).toHaveLength(2);
  });
});
