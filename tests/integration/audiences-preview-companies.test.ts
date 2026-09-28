import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audienceMembers, brandSuppressions, leadServes } from "../../src/db/schema.js";
import { oneLine } from "../../src/lib/apollo-audiences.js";

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000c7";
const APOLLO_AUD = "apollo-aud-companies";

const fetchBefore = globalThis.fetch;
const fetchSpy = vi.fn();

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

// apollo-service's deployed shape (GET /audiences/{id}/companies, v0.39.19).
function apolloCompany(rank: number) {
  return {
    rank,
    name: `Company ${rank}`,
    apolloOrganizationId: `org-${rank}`,
    domain: `company${rank}.com`,
    websiteUrl: `http://www.company${rank}.com`,
    logoUrl: `https://logo/${rank}.png`,
    linkedinUrl: `http://www.linkedin.com/company/c${rank}`,
    shortDescription: `Company ${rank} makes things. It has a long second sentence that must not reach the row.`,
    industry: "retail",
    estimatedNumEmployees: 12,
    city: "Zurich",
    state: "Zurich",
    country: "Switzerland",
    foundedYear: 1999,
    annualRevenuePrinted: "3M",
    totalFundingPrinted: null,
    latestFundingStage: null,
    keywords: ["drugstore"],
    peopleInSample: 1,
    person: { apolloPersonId: `person-${rank}`, firstName: `First${rank}`, lastNameObfuscated: `La***${rank}`, title: "Owner" },
  };
}

// The audience has `available` companies in apollo-service's rank order.
let available = 40;
const companyCalls: Array<{ offset: number; limit: number; runId: string | undefined }> = [];
const enrichCalls: string[] = [];

function route() {
  fetchSpy.mockImplementation(async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
    const u = new URL(String(url));
    if (u.pathname === `/audiences/${APOLLO_AUD}/companies`) {
      const offset = Number(u.searchParams.get("offset"));
      const limit = Number(u.searchParams.get("limit"));
      companyCalls.push({ offset, limit, runId: init.headers?.["x-run-id"] });
      const end = Math.min(offset + limit, available, 100);
      const companies = [];
      for (let r = offset + 1; r <= end; r++) companies.push(apolloCompany(r));
      return ok({ apolloAudienceId: APOLLO_AUD, count: 900, offset, limit, companies, hasMore: end < Math.min(available, 100), creditsCharged: companies.length });
    }
    if (u.pathname === "/enrich") {
      const id = JSON.parse(init.body ?? "{}").apolloPersonId as string;
      enrichCalls.push(id);
      if (id === "person-2") return ok({ person: { id, email: null }, emailVerification: null });
      return ok({
        person: { id, email: `boss@${id}.com` },
        emailVerification: { email: `boss@${id}.com`, verdict: "valid", deliverable: true, verifier: "bounceverify" },
      });
    }
    throw new Error("unexpected url " + u);
  });
}

async function createAudience(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({ brandId: BRAND, name, provider: "apollo", apolloAudienceId: APOLLO_AUD, filters: { personTitles: ["Owner"] }, ...extra });
  expect(res.status).toBe(201);
  return res.body.audience.id as string;
}

const page = (id: string, q = "") => request(app).get(`/orgs/audiences/${id}/preview/companies${q}`).set(getAuthHeaders());
const check = (id: string, index: number) =>
  request(app).post(`/orgs/audiences/${id}/preview/companies/${index}/email-check`).set(getAuthHeaders());
const checks = (id: string) => request(app).get(`/orgs/audiences/${id}/preview/companies/email-checks`).set(getAuthHeaders());

beforeEach(async () => {
  fetchSpy.mockReset();
  companyCalls.length = 0;
  enrichCalls.length = 0;
  available = 40;
  vi.stubGlobal("fetch", fetchSpy);
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  route();
  await cleanTestData();
});

afterAll(async () => {
  globalThis.fetch = fetchBefore;
  await closeDb();
});

describe("GET /orgs/audiences/:id/preview/companies", () => {
  it("first page: real companies with firmographics + one masked person, never an email", async () => {
    const id = await createAudience("First page");
    const res = await page(id, "?limit=10");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.rows).toHaveLength(10);
    expect(res.body.rows[0]).toEqual({
      index: 0,
      company: {
        name: "Company 1",
        domain: "company1.com",
        website: "http://www.company1.com",
        logoUrl: "https://logo/1.png",
        description: "Company 1 makes things.",
        location: "Zurich, Switzerland",
        city: "Zurich",
        country: "Switzerland",
        employeeCount: 12,
        industry: "retail",
        linkedinUrl: "http://www.linkedin.com/company/c1",
        foundedYear: 1999,
        annualRevenue: "3M",
        totalFunding: null,
        latestFundingStage: null,
        keywords: ["drugstore"],
      },
      person: { firstName: "First1", lastNameObfuscated: "La***1", title: "Owner", linkedinUrl: null },
    });
    expect(res.body.nextOffset).toBe(10);
    expect(res.body.done).toBe(false);
    expect(res.body.totalAvailable).toBe(10);
    // Built only as far as asked: one chunk of 10, under the caller's run.
    expect(companyCalls).toEqual([{ offset: 0, limit: 10, runId: getAuthHeaders()["x-run-id"] }]);
    expect(JSON.stringify(res.body)).not.toMatch(/email|phone|person-1/i);
  });

  it("pages progressively, then serves every read from storage with no second provider call", async () => {
    const id = await createAudience("Paging");
    await page(id, "?limit=10");
    const rest = await page(id, "?offset=10&limit=90");
    expect(rest.body.rows.map((r: { index: number }) => r.index)).toEqual(Array.from({ length: 30 }, (_, i) => i + 10));
    expect(rest.body.done).toBe(true);
    expect(rest.body.nextOffset).toBeNull();
    expect(rest.body.totalAvailable).toBe(40);
    expect(companyCalls.map((c) => [c.offset, c.limit])).toEqual([[0, 10], [10, 90]]);

    const again = await page(id, "?offset=0&limit=100");
    expect(again.body.rows).toHaveLength(40);
    expect(again.body.rows[5].company.name).toBe("Company 6");
    expect(companyCalls).toHaveLength(2);
  });

  it("stops at 100 companies", async () => {
    available = 500;
    const id = await createAudience("Capped");
    const res = await page(id, "?limit=100");
    expect(res.body.rows).toHaveLength(100);
    expect(res.body.done).toBe(true);
    expect(res.body.nextOffset).toBeNull();
    const beyond = await page(id, "?offset=100&limit=10");
    expect(beyond.body.rows).toEqual([]);
    expect(companyCalls).toHaveLength(1);
  });

  it("an audience with no companies is empty, final", async () => {
    available = 0;
    const id = await createAudience("Nobody");
    const res = await page(id);
    expect(res.body.status).toBe("empty");
    expect(res.body.reason).toBe("no_match");
    expect(res.body.done).toBe(true);
    await page(id);
    expect(companyCalls).toHaveLength(1);
  });

  it("an audience whose apollo build has not landed is unavailable, spends nothing", async () => {
    const res0 = await request(app)
      .post("/orgs/audiences")
      .set(getAuthHeaders())
      .send({ brandId: BRAND, name: "Not built", provider: "apollo" });
    const res = await page(res0.body.audience.id);
    expect(res.body.status).toBe("unavailable");
    expect(res.body.reason).toBe("not_built_yet");
    expect(companyCalls).toHaveLength(0);
  });

  it("two concurrent first reads never pay for the same chunk twice", async () => {
    const id = await createAudience("Concurrent");
    const [a, b] = await Promise.all([page(id, "?limit=10"), page(id, "?limit=10")]);
    expect(a.body.rows).toHaveLength(10);
    expect(b.body.rows).toHaveLength(10);
    expect(companyCalls).toHaveLength(1);
  });

  it("a provider failure is a 502 and stores nothing; the next call retries", async () => {
    const id = await createAudience("Fails");
    fetchSpy.mockImplementation(async () => ({ ok: false, status: 402, json: async () => ({}), text: async () => "credit_insufficient" }));
    const failed = await page(id);
    expect(failed.status).toBe(502);
    expect(failed.body.upstreamStatus).toBe(402);
    route();
    const retried = await page(id, "?limit=5");
    expect(retried.body.rows).toHaveLength(5);
  });

  it("rejects a bad limit, and another org's audience is 404", async () => {
    const id = await createAudience("Validation");
    expect((await page(id, "?limit=101")).status).toBe(400);
    const foreign = await request(app)
      .get(`/orgs/audiences/${id}/preview/companies`)
      .set({ ...getAuthHeaders(), "x-org-id": "00000000-0000-0000-0000-0000000000ff" });
    expect(foreign.status).toBe(404);
  });
});

describe("company row email checks", () => {
  it("checks ONE row's person, reports finder + verdict without the address, and never re-pays", async () => {
    const id = await createAudience("Row check");
    await page(id, "?limit=10");

    const pending = await checks(id);
    expect(pending.body.maxCheckable).toBe(10);
    expect(pending.body.checks).toHaveLength(10);
    expect(pending.body.checks[0].status).toBe("pending");

    const first = await check(id, 0);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      index: 0,
      status: "found",
      finder: "apollo",
      verifier: "bounceverify",
      verdict: "valid",
      deliverable: true,
      maskedEmail: "***@person-1.com",
    });
    expect(JSON.stringify(first.body)).not.toContain("boss@");

    const miss = await check(id, 1);
    expect(miss.body).toMatchObject({ status: "not_found", maskedEmail: null });

    await check(id, 0);
    expect(enrichCalls).toEqual(["person-1", "person-2"]);
    const state = await checks(id);
    expect(state.body.checks.slice(0, 3).map((c: { status: string }) => c.status)).toEqual(["found", "not_found", "pending"]);
  });

  it("does not collide with the /preview sample's email checks at the same position", async () => {
    const id = await createAudience("No collision");
    await page(id, "?limit=10");
    await check(id, 0);
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith(`/audiences/${APOLLO_AUD}/preview`)) {
        return ok({ apolloAudienceId: APOLLO_AUD, count: 1, companies: [{ name: "X", peopleInSample: 1 }], people: [{ apolloPersonId: "p-x", firstName: "X", lastNameObfuscated: "X***", title: "T", company: "X" }] });
      }
      throw new Error("unexpected " + url);
    });
    const previewChecks = await request(app).get(`/orgs/audiences/${id}/preview/email-checks`).set(getAuthHeaders());
    expect(previewChecks.body.people[0].status).toBe("pending");
  });

  it("only the first 10 rows are checkable; an unbuilt row is 404", async () => {
    available = 30;
    const id = await createAudience("Bounds");
    expect((await check(id, 0)).status).toBe(404);
    await page(id, "?limit=30");
    expect((await check(id, 10)).status).toBe(400);
    expect(enrichCalls).toEqual([]);
  });

  it("is not a serve: no suppression, no serve record, no membership", async () => {
    const id = await createAudience("Not a serve");
    await page(id, "?limit=3");
    await check(id, 0);
    expect(await db.select().from(leadServes)).toHaveLength(0);
    expect(await db.select().from(brandSuppressions)).toHaveLength(0);
    expect(await db.select().from(audienceMembers)).toHaveLength(0);
  });
});

describe("oneLine", () => {
  it("keeps the first sentence, caps it, and never invents one", () => {
    expect(oneLine(null)).toBeNull();
    expect(oneLine("   ")).toBeNull();
    expect(oneLine("Acme sells soap.\n\nFounded in 1990.")).toBe("Acme sells soap.");
    expect(oneLine("No period here")).toBe("No period here");
    const long = oneLine("x".repeat(500))!;
    expect(long.length).toBe(200);
    expect(long.endsWith("…")).toBe(true);
  });
});
