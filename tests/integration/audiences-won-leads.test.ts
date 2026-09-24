import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { isOptOutUrl, optOutResponse, setOptOutEnv } from "../helpers/opt-outs.js";
import { isWonLeadsUrl, setWonLeadsEnv, wonLeadsResponse } from "../helpers/won-leads.js";
import { db } from "../../src/db/index.js";
import { brandSuppressions, people } from "../../src/db/schema.js";

// A brand must never cold-contact a person it has already WON (a paying client).
// lead-service owns the "won" fact; every test here is about what this gateway
// does with it: exclude the person for THAT brand, permanently, at the point
// where excluding them still avoids a paid reveal — and refuse to serve when the
// won set cannot be read.

const app = createTestApp();
const ORG = "00000000-0000-0000-0000-000000000001";
const BRAND_A = "00000000-0000-4000-8000-0000000000b1";
const BRAND_B = "00000000-0000-4000-8000-0000000000b2";

const fetchSpy = vi.fn();
const fetchBeforeThisSuite = globalThis.fetch;

// brandId -> the addresses lead-service reports as won for it.
let wonByBrand: Record<string, string[]> = {};
let wonSourceDown = false;
let wonCalls: string[] = [];

beforeEach(async () => {
  // The consent log answers empty, ahead of the spy: this suite is about won.
  vi.stubGlobal("fetch", async (url: string, init: { body?: string }) =>
    isOptOutUrl(url) ? ok(optOutResponse(url, [])) : fetchSpy(url, init)
  );
  fetchSpy.mockReset();
  wonByBrand = {};
  wonSourceDown = false;
  wonCalls = [];
  setOptOutEnv();
  setWonLeadsEnv();
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.APIFY_SERVICE_URL = "http://apify:8080";
  process.env.APIFY_SERVICE_API_KEY = "apify-key";
  process.env.CRM_SERVICE_URL = "http://crm:8080";
  process.env.CRM_SERVICE_API_KEY = "crm-key";
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
    title: "CEO",
    headline: null,
    seniority: "c_suite",
    linkedinUrl: `https://www.linkedin.com/in/${id}`,
    photoUrl: null,
    city: null,
    state: null,
    country: null,
    organizationName: "Acme",
    organizationDomain: "acme.com",
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

function revealed(id: string) {
  return { ...teaser(id), lastName: "D", name: "C D", email: `${id}@acme.com`, emailStatus: "verified" };
}

// Route apollo + the consent log. `pages` is the teaser stream; every reveal is
// recorded so a test can assert the credit was NOT spent.
function mockApollo(pages: string[][]) {
  const enriched: string[] = [];
  let page = 0;
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (isWonLeadsUrl(u)) {
      wonCalls.push(u);
      if (wonSourceDown)
        return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" };
      return ok(wonLeadsResponse(u, wonByBrand));
    }
    if (u.endsWith("/search/next")) {
      const ids = pages[page] ?? [];
      page += 1;
      return ok({ people: ids.map(teaser), done: ids.length === 0, totalEntries: ids.length });
    }
    if (u.endsWith("/enrich")) {
      const id = (JSON.parse(init.body ?? "{}") as { apolloPersonId?: string }).apolloPersonId ?? "";
      enriched.push(id);
      return ok({ person: revealed(id) });
    }
    throw new Error("unexpected url " + u);
  });
  return { enriched };
}

async function createAudience(
  provider: "apollo" | "apify" | "crm",
  name: string,
  brandId: string
) {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({
      name,
      brandId,
      provider,
      ...(provider === "crm" ? {} : { filters: { titles: ["CEO"] } }),
    });
  expect(res.status).toBe(201);
  return res.body.audience.id as string;
}

function serveNext(id: string) {
  return request(app).post(`/orgs/audiences/${id}/serve-next`).set(getAuthHeaders());
}

// The canonical person row a prior serve would have written — it is what ties an
// won person's ADDRESS to the keys a free teaser carries (linkedin url, apollo
// person id), which is how the won gate fires before anyone pays.
async function knownPerson(id: string) {
  await db.insert(people).values({
    orgId: ORG,
    emailNorm: `${id}@acme.com`,
    linkedinUrlNorm: `linkedin.com/in/${id}`,
    apolloPersonId: id,
  });
}

describe("a won person on the apollo serve path", () => {
  it("drops the teaser BEFORE the reveal — the credit is never spent", async () => {
    await knownPerson("client");
    wonByBrand = { [BRAND_A]: ["client@acme.com"] };
    const calls = mockApollo([["client", "prospect"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("prospect@acme.com");
    expect(calls.enriched).toEqual(["prospect"]);
    // Asked about THIS brand, with the org identity lead-service scopes on.
    expect(wonCalls.every((u) => u.includes(`/orgs/brands/${BRAND_A}/won-leads`))).toBe(true);
  });

  it("is permanent — a suppression row older than 3 months changes nothing", async () => {
    await knownPerson("client");
    await db.insert(brandSuppressions).values({
      orgId: ORG,
      brandId: BRAND_A,
      emailNorm: "client@acme.com",
      linkedinUrlNorm: "linkedin.com/in/client",
      providerPersonId: "client",
      lastProvider: "apollo",
    });
    await db
      .update(brandSuppressions)
      .set({ lastServedAt: sql`now() - interval '6 months'` })
      .where(
        and(
          eq(brandSuppressions.orgId, ORG),
          eq(brandSuppressions.emailNorm, "client@acme.com")
        )
      );
    wonByBrand = { [BRAND_A]: ["client@acme.com"] };
    const calls = mockApollo([["client", "prospect"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.body.person.email).toBe("prospect@acme.com");
    expect(calls.enriched).toEqual(["prospect"]);
  });

  it("stays servable for ANOTHER brand of the same org", async () => {
    await knownPerson("client");
    // Won by brand A only; this audience serves brand B.
    wonByBrand = { [BRAND_A]: ["client@acme.com"] };
    const calls = mockApollo([["client", "prospect"]]);
    const id = await createAudience("apollo", "B", BRAND_B);

    const res = await serveNext(id);
    expect(res.body.person.email).toBe("client@acme.com");
    expect(calls.enriched).toEqual(["client"]);
  });

  it("a sale withdrawn upstream puts the person straight back in the pool", async () => {
    await knownPerson("client");
    // lead-service no longer reports them — nothing is stored here to expire.
    wonByBrand = {};
    const calls = mockApollo([["client", "prospect"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.body.person.email).toBe("client@acme.com");
    expect(calls.enriched).toEqual(["client"]);
  });

  it("blocks after the reveal when no prior serve tied the address to a teaser key", async () => {
    // No `people` row ⟹ the free teaser carries nothing to match on; the narrowed
    // ?email= read catches them post-reveal and they are never handed back.
    wonByBrand = { [BRAND_A]: ["ghost@acme.com"] };
    const calls = mockApollo([["ghost", "prospect"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.person.email).toBe("prospect@acme.com");
    expect(calls.enriched).toEqual(["ghost", "prospect"]);
    expect(wonCalls.some((u) => u.includes("email=ghost%40acme.com"))).toBe(true);
  });

  it("REFUSES the serve when the won set cannot be read", async () => {
    wonSourceDown = true;
    const calls = mockApollo([["prospect"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.status).toBe(502);
    expect(res.body.source).toBe("lead-service");
    expect(calls.enriched).toEqual([]);
  });

  it("REFUSES the serve when lead-service is not configured", async () => {
    delete process.env.LEAD_SERVICE_URL;
    const calls = mockApollo([["prospect"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.status).toBe(502);
    expect(calls.enriched).toEqual([]);
  });
});

describe("a won person on the apify serve path", () => {
  it("rides the exclude-set pushed down, so the actor never bills the person", async () => {
    await knownPerson("client");
    wonByBrand = { [BRAND_A]: ["client@acme.com"] };
    let searchBody: Record<string, unknown> = {};
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (isWonLeadsUrl(u)) return ok(wonLeadsResponse(u, wonByBrand));
      if (u.endsWith("/search")) {
        searchBody = JSON.parse(init.body ?? "{}");
        return ok({ leads: [], leadCount: 0, verifiedCount: 0, hasMore: false });
      }
      throw new Error("unexpected url " + u);
    });
    const id = await createAudience("apify", "A", BRAND_A);

    await serveNext(id);
    expect(searchBody.excludeEmails).toContain("client@acme.com");
    expect(searchBody.excludeLinkedinUrls).toContain("linkedin.com/in/client");
  });
});

describe("the crm serve path", () => {
  it("is untouched — crm-service owns its own dedup, no won read is made", async () => {
    wonByBrand = { [BRAND_A]: ["client@acme.com"] };
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (isWonLeadsUrl(u)) {
        wonCalls.push(u);
        return ok(wonLeadsResponse(u, wonByBrand));
      }
      if (u.endsWith("/serve-next"))
        return ok({
          contacts: [
            { id: "c1", primaryEmail: "client@acme.com", phoneE164: null, fullName: "C", firstName: "C", lastName: null },
          ],
          served: 1,
          exhausted: false,
        });
      throw new Error("unexpected url " + u);
    });
    const id = await createAudience("crm", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.person.email).toBe("client@acme.com");
    expect(wonCalls).toEqual([]);
  });
});
