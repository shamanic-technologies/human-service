import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// FRESH-2-MONTHS-1027: `excludeEmailedWithin` on serve-next / candidates.
// A serve stating 2_months hands out a person of the brand last served/emailed
// more than 2 months ago; absent / 3_months keeps today's 3-month suppression.
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  audienceCandidates,
  audienceMembers,
  audiences,
  brandSuppressions,
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
const THREE = { excludeEmailedWithin: "3_months" };

describe("excludeEmailedWithin — validation", () => {
  it("400s an unknown value on every route", async () => {
    const id = await createAudience();
    for (const r of [serveNext(id, { excludeEmailedWithin: "1_month" }), next(id, { excludeEmailedWithin: "1_month" })]) {
      const res = await r;
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/excludeEmailedWithin/);
    }
    const rv = await reveal(id, "00000000-0000-4000-8000-000000000001", { excludeEmailedWithin: "1_month" });
    expect(rv.status).toBe(400);
  });
});

describe("serve-next — people this audience served, lapsed under the serve's window", () => {
  it("2_months hands the person served 70 days ago (records a new serve), never the one served 40 days ago", async () => {
    const id = await createAudience();
    await seedServed(id, "old70", 70, { sent: true });
    await seedServed(id, "new40", 40, { sent: true });
    const fleet = mockApollo([[]]);

    const res = await serveNext(id, TWO);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.person).toMatchObject({ email: "old70@x.com", providerPersonId: "old70" });
    // Re-revealed through apollo-service (its person cache answers: no credit).
    expect(fleet.enriched).toEqual(["old70"]);
    // A new serve: bronze row written, window restarts from now.
    expect(await db.select().from(leadServes).where(eq(leadServes.providerPersonId, "old70"))).toHaveLength(2);
    expect(Date.now() - (await anchorOf("old70")).getTime()).toBeLessThan(60_000);
    expect((await anchorOf("new40")).getTime()).toBeLessThan(daysAgo(39).getTime());

    // Nobody else: the 40-day person stays suppressed, the 70-day one is fresh again.
    const again = await serveNext(id, TWO);
    expect(again.body).toEqual({ status: "exhausted", person: null });
    expect(fleet.enriched).toEqual(["old70"]);
  });

  it("stating nothing (or 3_months) never hands the 70-day person: today's serve", async () => {
    for (const body of [{}, THREE]) {
      await cleanTestData();
      const id = await createAudience();
      await seedServed(id, "old70", 70, { sent: true });
      const fleet = mockApollo([[]]);
      const res = await serveNext(id, body);
      expect(res.body).toEqual({ status: "exhausted", person: null });
      expect(fleet.enriched).toEqual([]);
    }
  });

  it("the free teaser filter and the claim follow the window: a teaser of a person served 70 days ago under ANOTHER audience", async () => {
    const other = await createAudience();
    await seedServed(other, "t70", 70);
    await db.update(audiences).set({ name: "Other" }).where(eq(audiences.id, other));
    const plain = await createAudience();
    await db.update(audiences).set({ name: "Plain" }).where(eq(audiences.id, plain));
    const id = await createAudience();

    // Candidate path: no screen in between, the free filter and the claim alone.
    let fleet = mockApollo([["t70"], []]);
    expect((await next(plain)).body).toMatchObject({ status: "exhausted" });
    expect(fleet.enriched).toEqual([]);

    fleet = mockApollo([["t70"], []]);
    const offered = await next(id, TWO);
    expect(offered.body.status).toBe("candidate");
    expect(offered.body.candidate.providerPersonId).toBe("t70");
    const res = await reveal(id, offered.body.candidate.candidateId, TWO);
    expect(res.body).toMatchObject({ status: "served" });
    expect(res.body.person.email).toBe("t70@x.com");
    expect(fleet.enriched).toEqual(["t70"]);
  });

  it("a person only served (never handed nor emailed) is not re-reached", async () => {
    const id = await createAudience();
    await seedServed(id, "dropped", 70);
    await db.delete(audienceMembers);
    mockApollo([[]]);
    expect((await serveNext(id, TWO)).body).toEqual({ status: "exhausted", person: null });
  });
});

describe("candidates — the same re-contact under the serve's window", () => {
  it("2_months re-offers the 70-day person (their candidate row re-opened) and the reveal serves them", async () => {
    const id = await createAudience();
    const fleet = mockApollo([["c70"], []]);
    const first = (await next(id)).body.candidate.candidateId as string;
    expect((await reveal(id, first)).body).toMatchObject({ status: "served" });
    // Make that serve 70 days old.
    await db.update(brandSuppressions).set({ lastServedAt: daysAgo(70), lastSentAt: daysAgo(70) });

    expect((await next(id)).body).toMatchObject({ status: "exhausted" });
    const offered = await next(id, TWO);
    expect(offered.body.status).toBe("candidate");
    expect(offered.body.candidate.candidateId).toBe(first);

    // A reveal NOT stating the window keeps the 3-month claim: not served.
    expect((await reveal(id, first)).body).toMatchObject({ status: "not_served", reason: "already_served" });
    await db.update(audienceCandidates).set({ status: "revealed" });
    const reoffered = (await next(id, TWO)).body.candidate.candidateId as string;
    const res = await reveal(id, reoffered, TWO);
    expect(res.body).toMatchObject({ status: "served", replayed: false });
    expect(res.body.person.email).toBe("c70@x.com");
    expect(fleet.enriched).toEqual(["c70", "c70", "c70"]);
    expect(Date.now() - (await anchorOf("c70")).getTime()).toBeLessThan(60_000);
    // Served again just now: not offered again.
    expect((await next(id, TWO)).body).toMatchObject({ status: "exhausted" });
  });

  it("2_months never offers a person served 40 days ago", async () => {
    const id = await createAudience();
    await seedServed(id, "c40", 40, { sent: true });
    mockApollo([[]]);
    expect((await next(id, TWO)).body).toMatchObject({ status: "exhausted" });
  });
});
