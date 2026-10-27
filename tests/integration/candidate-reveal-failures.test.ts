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
  brandSuppressions,
  people,
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

// A switch to make the person write inside a reveal throw (the "any failure
// inside a reveal" cases); off by default, so the real write runs.
const failWrite = vi.hoisted(() => ({ err: null as unknown }));
vi.mock("../../src/services/audience-provenance.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolvePersonId: async (...args: unknown[]) => {
      if (failWrite.err) throw failWrite.err;
      return (actual.resolvePersonId as (...a: unknown[]) => Promise<string>)(...args);
    },
  };
});

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000c1";
const ORG = getAuthHeaders()["x-org-id"];

const fetchSpy = vi.fn();
const fetchBeforeThisSuite = globalThis.fetch;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);

beforeEach(async () => {
  unhandled.length = 0;
  failWrite.err = null;
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  await cleanTestData();
});

afterAll(async () => {
  process.off("unhandledRejection", onUnhandled);
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

// DOCDINNERS-REVEAL-HANG-1027: the revealed address already belonged to ANOTHER
// people row of the org than the one holding the Apollo id. The person write
// moved the address onto the Apollo-id row, hit idx_people_org_email, and the
// request was never answered (lead-service waited 300 s, every run, for 30 h).
describe("candidate reveal — the address belongs to another person row", () => {
  async function twoRows() {
    const [byApolloId] = await db
      .insert(people)
      .values({ orgId: ORG, apolloPersonId: "p1", emailNorm: "old@clinic.com" })
      .returning();
    const [byEmail] = await db.insert(people).values({ orgId: ORG, emailNorm: "p1@x.com" }).returning();
    return { byApolloId, byEmail };
  }

  it("serves, resolved to the row holding the address", async () => {
    const id = await createAudience();
    mockApollo([["p1"]]);
    const { byApolloId, byEmail } = await twoRows();
    const c = (await next(id)).body.candidate.candidateId as string;
    const res = await reveal(id, c);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "served", personId: byEmail.id });
    const [kept] = await db.select().from(people).where(eq(people.id, byApolloId.id));
    expect(kept.emailNorm).toBe("old@clinic.com");
    expect(unhandled).toEqual([]);
  });

  it("already served for the brand: answers not_served, tags the address holder", async () => {
    const id = await createAudience();
    mockApollo([["p1"]]);
    await twoRows();
    await db.insert(brandSuppressions).values({ orgId: ORG, brandId: BRAND, emailNorm: "p1@x.com" });
    const c = (await next(id)).body.candidate.candidateId as string;
    const res = await reveal(id, c);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "not_served", reason: "already_served" });
    expect(unhandled).toEqual([]);
  });
});

describe("candidate reveal — any failure answers the request", () => {
  it("an unexpected error answers a named 500 and the candidate goes to the back of the queue", async () => {
    const id = await createAudience();
    mockApollo([["p1", "p2"]]);
    const c = (await next(id)).body.candidate.candidateId as string;
    failWrite.err = new Error("boom in the person write");
    const res = await reveal(id, c);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "boom in the person write", reason: "internal_error" });
    const [row] = await db.select().from(audienceCandidates).where(eq(audienceCandidates.id, c));
    expect(row.status).toBe("offered");
    expect(row.offeredAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Not at the head: the next call offers someone else.
    expect((await next(id)).body.candidate.providerPersonId).toBe("p2");
    expect(unhandled).toEqual([]);
  });

  it("a failure in our own data closes the candidate: never offered again", async () => {
    const id = await createAudience();
    mockApollo([["p1", "p2"]]);
    const c = (await next(id)).body.candidate.candidateId as string;
    failWrite.err = Object.assign(new Error("Failed query: update people"), {
      cause: Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
    });
    const res = await reveal(id, c);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed query: update people");
    const [row] = await db.select().from(audienceCandidates).where(eq(audienceCandidates.id, c));
    expect(row.status).toBe("declined");
    expect(row.declineReason).toMatch(/^reveal_failed: /);
    expect(await db.select().from(audienceScreenedOut)).toHaveLength(1);
    failWrite.err = null;
    await db
      .update(audienceCandidates)
      .set({ offeredAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(audienceCandidates.id, c));
    expect((await next(id)).body.candidate.providerPersonId).toBe("p2");
    expect((await reveal(id, c)).status).toBe(409);
  });
});
