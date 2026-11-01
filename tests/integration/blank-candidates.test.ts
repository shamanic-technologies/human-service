import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// BLANK-CANDIDATES-1101: a candidate is never offered for judgment without facts
// about the person; the repair re-offers the ones declined while blank; an
// exhausted audience's Remaining counts only who it can still hand out.
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  audienceCandidates,
  audienceMembers,
  audienceScreenedOut,
  audienceTeaserBuffer,
  audiences,
  brandSuppressions,
  leadServes,
  candidateRejudges,
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
const BRAND = "00000000-0000-4000-8000-0000000000c7";
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

let audienceSeq = 0;
async function createAudience() {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({
      name: `Chiros ${++audienceSeq}`,
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

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

// A person this audience served and handed `days` ago: the bronze serve, the
// brand claim anchored then, and their served membership.
async function seedServed(audienceId: string, id: string, days: number, opts: { sent?: boolean } = {}) {
  const at = daysAgo(days);
  await db.insert(leadServes).values({
    orgId: ORG, brandId: BRAND, provider: "apollo", providerPersonId: id,
    firstName: "Jane", lastName: "Roe", email: `${id}@x.com`, linkedinUrl: `linkedin.com/in/${id}`,
    companyDomain: `${id}.example`, audienceId, emailVerdict: "valid", servedAt: at,
  });
  await db.insert(brandSuppressions).values({
    orgId: ORG, brandId: BRAND, emailNorm: `${id}@x.com`, linkedinUrlNorm: `linkedin.com/in/${id}`,
    providerPersonId: id, lastProvider: "apollo", firstServedAt: at, lastServedAt: at,
    lastSentAt: opts.sent ? at : null,
  });
  const [p] = await db.insert(people).values({ orgId: ORG, emailNorm: `${id}@x.com`, apolloPersonId: id }).returning();
  await db.insert(audienceMembers).values({ orgId: ORG, audienceId, personId: p.id, provenance: "served" });
}

async function anchorOf(id: string): Promise<Date> {
  const [row] = await db.select().from(brandSuppressions).where(eq(brandSuppressions.emailNorm, `${id}@x.com`));
  return row.lastServedAt;
}

const serveNext = (id: string, body: object = {}) =>
  request(app).post(`/orgs/audiences/${id}/serve-next`).set(getAuthHeaders()).send(body);
const next = (id: string, body: object = {}) =>
  request(app).post(`/orgs/audiences/${id}/candidates/next`).set(getAuthHeaders()).send(body);
const reveal = (id: string, c: string, body: object = {}) =>
  request(app).post(`/orgs/audiences/${id}/candidates/${c}/reveal`).set(getAuthHeaders()).send(body);

const TWO = { excludeEmailedWithin: "2_months" };

const SNAPSHOT = {
  name: "Jace B.", title: "Chiropractor", headline: null, seniority: "owner", city: "Denver", state: "Colorado",
  country: "United States", organizationName: "WellSet", organizationIndustry: "health", organizationEmployees: 5,
  organizationCity: null, organizationState: null, organizationCountry: null, organizationKeywords: null,
};

// Another audience of the brand that once held this person's teaser (a candidate row).
async function seedTeaserElsewhere(id: string) {
  const other = await createAudience();
  await db.insert(audienceCandidates).values({
    orgId: ORG, audienceId: other, providerPersonId: id, linkedinUrl: `linkedin.com/in/${id}`,
    teaser: SNAPSHOT, organizationDomain: `${id}.example`, status: "revealed", decidedAt: daysAgo(80),
  });
  return other;
}

async function blankRowsOf(audienceId: string) {
  const rows = await db.select().from(audienceCandidates).where(eq(audienceCandidates.audienceId, audienceId));
  return rows.filter((r) => !r.teaser || !(r.teaser.title || r.teaser.headline));
}

describe("candidates — never offered for judgment without facts about the person", () => {
  it("today's blank row: a person served in July (no teaser stored anywhere) is NOT offered by the 2-month re-contact", async () => {
    const id = await createAudience();
    await seedServed(id, "jace", 70, { sent: true });
    mockApollo([[]]);
    const res = await next(id, TWO);
    expect(res.body).toMatchObject({ status: "exhausted" });
    expect(await blankRowsOf(id)).toHaveLength(0);
  });

  it("the same person, whose teaser another audience holds, is offered WITH it: the judged input names the person's role", async () => {
    const id = await createAudience();
    await seedServed(id, "jace", 70, { sent: true });
    await seedTeaserElsewhere("jace");
    mockApollo([[]]);
    const res = await next(id, TWO);
    expect(res.body.status).toBe("candidate");
    expect(res.body.candidate.providerPersonId).toBe("jace");
    const [row] = await db
      .select()
      .from(audienceCandidates)
      .where(and(eq(audienceCandidates.audienceId, id), eq(audienceCandidates.providerPersonId, "jace")));
    expect(row.teaser?.title).toBe("Chiropractor");
    expect(await blankRowsOf(id)).toHaveLength(0);
  });

  it("a person with nothing stored here gets what apollo-service's stored reveal said about them", async () => {
    const id = await createAudience();
    await seedServed(id, "jace", 70, { sent: true });
    (globalThis as { apolloPersonFacts?: Map<string, unknown> }).apolloPersonFacts = new Map([
      ["jace", { ...SNAPSHOT, name: null, title: "Doctor of Chiropractic" }],
    ]);
    try {
      mockApollo([[]]);
      const res = await next(id, TWO);
      expect(res.body.status).toBe("candidate");
      const [row] = await db.select().from(audienceCandidates).where(eq(audienceCandidates.audienceId, id));
      expect(row.teaser?.title).toBe("Doctor of Chiropractic");
    } finally {
      delete (globalThis as { apolloPersonFacts?: unknown }).apolloPersonFacts;
    }
  });

  it("a buffered teaser with no snapshot takes the person's stored one, else is passed over", async () => {
    const id = await createAudience();
    await seedTeaserElsewhere("known");
    await db.insert(audienceTeaserBuffer).values([
      { orgId: ORG, audienceId: id, providerPersonId: "nofacts", teaser: null, createdAt: daysAgo(2) },
      { orgId: ORG, audienceId: id, providerPersonId: "known", teaser: null, createdAt: daysAgo(1) },
    ]);
    mockApollo([[]]);
    const res = await next(id);
    expect(res.body.status).toBe("candidate");
    expect(res.body.candidate.providerPersonId).toBe("known");
    expect(await blankRowsOf(id)).toHaveLength(0);
    expect((await next(id)).body).toMatchObject({ status: "exhausted" });
  });
});

const rejudge = (q = "") =>
  request(app).post(`/internal/rejudge-blank-candidates${q}`).set(getAuthHeaders()).send({ reason: "blank-1101" });

describe("POST /internal/rejudge-blank-candidates", () => {
  async function seedDeclinedBlank(audienceId: string, pid: string) {
    await db.insert(audienceCandidates).values({
      orgId: ORG, audienceId, providerPersonId: pid, linkedinUrl: `linkedin.com/in/${pid}`, teaser: null,
      organizationDomain: `${pid}.example`, status: "declined", declineReason: "screen_rejected P(yes)=0.070",
      basis: "screen:lead-v1;must:none", offeredAt: daysAgo(1), decidedAt: daysAgo(1),
    });
    await db.insert(audienceScreenedOut).values({
      orgId: ORG, audienceId, providerPersonId: pid, reason: "declined: screen_rejected P(yes)=0.070",
    });
  }

  it("re-offers a blank declined candidate with the person's stored teaser, lifts its rejection, is idempotent and reversible", async () => {
    const id = await createAudience();
    await seedDeclinedBlank(id, "jace");
    await seedDeclinedBlank(id, "ghost");
    await seedTeaserElsewhere("jace");

    const dry = await rejudge("?dryRun=true");
    expect(dry.body).toMatchObject({ dryRun: true, blank: 2, reoffered: 1, noPersonFacts: 1 });
    expect(await db.select().from(candidateRejudges)).toHaveLength(0);

    const real = await rejudge();
    expect(real.body).toMatchObject({ dryRun: false, blank: 2, reoffered: 1, noPersonFacts: 1, keptRejection: 0 });
    const [jace] = await db.select().from(audienceCandidates).where(and(eq(audienceCandidates.audienceId, id), eq(audienceCandidates.providerPersonId, "jace")));
    expect(jace).toMatchObject({ status: "offered", decidedAt: null, basis: null, declineReason: null });
    expect(jace.teaser?.title).toBe("Chiropractor");
    expect(await db.select().from(audienceScreenedOut).where(eq(audienceScreenedOut.providerPersonId, "jace"))).toHaveLength(0);
    // "ghost" stays as it was: nothing to judge it on.
    expect(await db.select().from(audienceScreenedOut).where(eq(audienceScreenedOut.providerPersonId, "ghost"))).toHaveLength(1);

    // The next candidates call of the audience re-offers it for a real judgment.
    mockApollo([[]]);
    const offered = await next(id);
    expect(offered.body.status).toBe("candidate");
    expect(offered.body.candidate.candidateId).toBe(jace.id);

    expect((await rejudge()).body).toMatchObject({ alreadyRejudged: 0, reoffered: 0 });

    const revert = await request(app).post("/internal/rejudge-blank-candidates/revert").set(getAuthHeaders()).send({ reason: "blank-1101" });
    expect(revert.body).toMatchObject({ restored: 1, rejectionsRestored: 1 });
    const [back] = await db.select().from(audienceCandidates).where(eq(audienceCandidates.id, jace.id));
    expect(back).toMatchObject({ status: "declined", teaser: null, basis: "screen:lead-v1;must:none" });
    expect(await db.select().from(audienceScreenedOut).where(eq(audienceScreenedOut.providerPersonId, "jace"))).toHaveLength(1);
  });

  it("BLIND-SCREEN-CACHE-1101: a re-offered candidate declined again on the verdict stored for its blank input is re-offered again, bounded by declinedBefore", async () => {
    const id = await createAudience();
    await seedDeclinedBlank(id, "jace");
    await seedTeaserElsewhere("jace");
    expect((await rejudge()).body).toMatchObject({ reoffered: 1 });
    // lead-service then declined it within minutes with the verdict judged on the blank teaser.
    const [row] = await db.select().from(audienceCandidates).where(and(eq(audienceCandidates.audienceId, id), eq(audienceCandidates.providerPersonId, "jace")));
    const declinedAt = new Date(Date.now() + 1000);
    await db.update(audienceCandidates).set({ status: "declined", declineReason: "screen_rejected P(yes)=0.110", basis: "screen:lead-v1;must:none", decidedAt: declinedAt }).where(eq(audienceCandidates.id, row.id));
    await db.insert(audienceScreenedOut).values({ orgId: ORG, audienceId: id, providerPersonId: "jace", reason: "declined: screen_rejected P(yes)=0.110" });

    const again = (body: Record<string, unknown>, q = "") =>
      request(app).post(`/internal/rejudge-blank-candidates${q}`).set(getAuthHeaders()).send({ reason: "blind-1101", ...body });
    // A decline made after the fix went live was judged on the real facts: left alone.
    expect((await again({ declinedBefore: new Date(declinedAt.getTime() - 1).toISOString() })).body).toMatchObject({ reDeclined: 0 });
    expect((await again({ declinedBefore: new Date(declinedAt.getTime() + 60_000).toISOString() }, "?dryRun=true")).body).toMatchObject({ dryRun: true, reDeclined: 1, blank: 0 });
    const real = await again({});
    expect(real.body).toMatchObject({ reDeclined: 1, keptRejection: 0 });
    expect(real.body.byAudience).toEqual([expect.objectContaining({ audienceId: id, reDeclined: 1 })]);
    const [back] = await db.select().from(audienceCandidates).where(eq(audienceCandidates.id, row.id));
    expect(back).toMatchObject({ status: "offered", decidedAt: null, declineReason: null, basis: null });
    expect(back.teaser?.title).toBe("Chiropractor");
    expect(await db.select().from(audienceScreenedOut).where(eq(audienceScreenedOut.providerPersonId, "jace"))).toHaveLength(0);
    expect((await again({})).body).toMatchObject({ reDeclined: 0 });

    const revert = await request(app).post("/internal/rejudge-blank-candidates/revert").set(getAuthHeaders()).send({ reason: "blind-1101" });
    expect(revert.body).toMatchObject({ restored: 1, rejectionsRestored: 1 });
    const [reverted] = await db.select().from(audienceCandidates).where(eq(audienceCandidates.id, row.id));
    expect(reverted).toMatchObject({ status: "declined", declineReason: "screen_rejected P(yes)=0.110" });
  });

  it("keeps a candidate whose rejection the pre-pay screen made on a real snapshot", async () => {
    const id = await createAudience();
    await seedDeclinedBlank(id, "jace");
    await db.update(audienceScreenedOut).set({ reason: "screen: off target" });
    await seedTeaserElsewhere("jace");
    expect((await rejudge()).body).toMatchObject({ reoffered: 0, keptRejection: 1 });
  });
});

describe("Remaining of an exhausted audience — nobody new from its provider", () => {
  it("counts only the people it served whose window lapsed, never the ones it found already taken", async () => {
    const id = await createAudience();
    await seedServed(id, "s100", 100); // served, lapsed: re-contactable
    await seedServed(id, "s10", 10); // served, in window
    for (const pid of ["t1", "t2", "t3"]) {
      const [p] = await db.insert(people).values({ orgId: ORG, emailNorm: `${pid}@x.com`, apolloPersonId: pid }).returning();
      await db.insert(audienceMembers).values({ orgId: ORG, audienceId: id, personId: p.id, provenance: "found_taken" });
    }
    await db.update(audiences).set({ reachableCount: 5 }).where(eq(audiences.id, id));
    const res = await request(app).get(`/orgs/audiences?brandId=${BRAND}`).set(getAuthHeaders());
    const item = res.body.audiences.find((a: { id: string }) => a.id === id);
    // Before: reachable 5 - suppressed 1 = 4 "left". Now: only s100 can still be handed out.
    expect(item.availableToContactCount).toBe(1);
  });
});
