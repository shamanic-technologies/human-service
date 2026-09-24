import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { isOptOutUrl, optOutResponse, setOptOutEnv } from "../helpers/opt-outs.js";
import { isWonLeadsUrl, setWonLeadsEnv, wonLeadsResponse } from "../helpers/won-leads.js";
import { db } from "../../src/db/index.js";
import { brandSuppressions, people } from "../../src/db/schema.js";

// A person who asked us to stop must never be emitted by the serve path — for
// ANY brand of the org, permanently, and at the point where excluding them still
// avoids a paid reveal. instantly-service owns the record; every test here is
// about what this gateway does with it.

const app = createTestApp();
const ORG = "00000000-0000-0000-0000-000000000001";
const BRAND_A = "00000000-0000-4000-8000-0000000000b1";
const BRAND_B = "00000000-0000-4000-8000-0000000000b2";

const fetchSpy = vi.fn();
const fetchBeforeThisSuite = globalThis.fetch;

// The org's standing opt-out addresses for the test in flight.
let standingOptOuts: string[] = [];
// Set to fail the consent-log read, to prove the gate refuses rather than serves.
let optOutSourceDown = false;

beforeEach(async () => {
  // The brand's won set (lead-service) is answered ahead of the spy — empty, so
  // this suite stays about opt-outs.
  vi.stubGlobal("fetch", async (url: string, init: { body?: string }) =>
    isWonLeadsUrl(url) ? ok(wonLeadsResponse(url)) : fetchSpy(url, init)
  );
  fetchSpy.mockReset();
  standingOptOuts = [];
  optOutSourceDown = false;
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
    if (isOptOutUrl(u)) {
      if (optOutSourceDown)
        return { ok: false, status: 503, json: async () => ({}), text: async () => "down" };
      return ok(optOutResponse(u, standingOptOuts));
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
// opt-out's ADDRESS to the keys a free teaser carries (linkedin url, apollo
// person id), which is how the gate fires before anyone pays.
async function knownPerson(id: string) {
  await db.insert(people).values({
    orgId: ORG,
    emailNorm: `${id}@acme.com`,
    linkedinUrlNorm: `linkedin.com/in/${id}`,
    apolloPersonId: id,
  });
}

describe("a standing opt-out on the apollo serve path", () => {
  it("drops the teaser BEFORE the reveal — the credit is never spent", async () => {
    await knownPerson("stopper");
    standingOptOuts = ["stopper@acme.com"];
    const calls = mockApollo([["stopper", "willing"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("willing@acme.com");
    // The whole point: nobody paid to reveal the person who asked us to stop.
    expect(calls.enriched).toEqual(["willing"]);
  });

  it("holds for a DIFFERENT brand of the same org — they told the SENDER to stop", async () => {
    await knownPerson("stopper");
    standingOptOuts = ["stopper@acme.com"];
    const calls = mockApollo([["stopper", "willing"]]);
    // The opt-out was never scoped to a brand, and this audience is another one.
    const id = await createAudience("apollo", "B", BRAND_B);

    const res = await serveNext(id);
    expect(res.body.person.email).toBe("willing@acme.com");
    expect(calls.enriched).toEqual(["willing"]);
  });

  it("does NOT expire — a lapsed 3-month suppression window changes nothing", async () => {
    await knownPerson("stopper");
    // This is the concrete production case: a person served long enough ago that
    // the re-contact window has lapsed is re-servable under suppression alone.
    await db.insert(brandSuppressions).values({
      orgId: ORG,
      brandId: BRAND_A,
      emailNorm: "stopper@acme.com",
      linkedinUrlNorm: "linkedin.com/in/stopper",
      providerPersonId: "stopper",
      lastProvider: "apollo",
    });
    await db
      .update(brandSuppressions)
      .set({ lastServedAt: sql`now() - interval '6 months'` })
      .where(
        and(
          eq(brandSuppressions.orgId, ORG),
          eq(brandSuppressions.emailNorm, "stopper@acme.com")
        )
      );
    standingOptOuts = ["stopper@acme.com"];
    const calls = mockApollo([["stopper", "willing"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.body.person.email).toBe("willing@acme.com");
    expect(calls.enriched).toEqual(["willing"]);
  });

  it("a WITHDRAWN opt-out puts the person straight back in the pool", async () => {
    await knownPerson("stopper");
    // Nothing stands: the record was taken back, so the read returns no standing
    // row and the very next serve emits them again.
    standingOptOuts = [];
    const calls = mockApollo([["stopper", "willing"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.body.person.email).toBe("stopper@acme.com");
    expect(calls.enriched).toEqual(["stopper"]);
  });

  it("blocks after the reveal when no prior serve tied the address to a teaser key", async () => {
    // No `people` row ⟹ the free teaser carries nothing the opt-out can be
    // matched on, so the block lands post-reveal. The credit is spent, the email
    // is not: the person is never handed back.
    standingOptOuts = ["ghost@acme.com"];
    const calls = mockApollo([["ghost"], []]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("exhausted");
    expect(res.body.person).toBeNull();
    expect(calls.enriched).toEqual(["ghost"]);
  });

  it("REFUSES the serve when the consent log cannot be read", async () => {
    optOutSourceDown = true;
    const calls = mockApollo([["willing"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.status).toBe(502);
    expect(res.body.source).toBe("instantly-service");
    // A gate that cannot read its own input serves nobody, and pays for nobody.
    expect(calls.enriched).toEqual([]);
  });
});

describe("a standing opt-out on the apify serve path", () => {
  it("rides the exclude-set pushed down, so the actor never bills the person", async () => {
    await knownPerson("stopper");
    standingOptOuts = ["stopper@acme.com"];
    let searchBody: Record<string, unknown> = {};
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (isOptOutUrl(u)) return ok(optOutResponse(u, standingOptOuts));
      if (u.endsWith("/search")) {
        searchBody = JSON.parse(init.body ?? "{}");
        return ok({ leads: [], leadCount: 0, verifiedCount: 0, hasMore: false });
      }
      throw new Error("unexpected url " + u);
    });
    const id = await createAudience("apify", "A", BRAND_A);

    await serveNext(id);
    expect(searchBody.excludeEmails).toContain("stopper@acme.com");
    expect(searchBody.excludeLinkedinUrls).toContain("linkedin.com/in/stopper");
  });

  it("is never handed back even if the actor returns them anyway", async () => {
    standingOptOuts = ["stopper@acme.com"];
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (isOptOutUrl(u)) return ok(optOutResponse(u, standingOptOuts));
      if (u.endsWith("/search"))
        return ok({
          leads: [
            {
              firstName: "A",
              lastName: "B",
              fullName: "A B",
              title: "CEO",
              seniority: "c_suite",
              email: "stopper@acme.com",
              emailStatus: "verified",
              source: "pipelinelabs",
              isCatchAll: false,
              isInferred: false,
              linkedinUrl: "https://linkedin.com/in/stopper",
              city: null,
              state: null,
              country: null,
              companyName: "Acme",
              companyDomain: "acme.com",
              companyIndustry: null,
              companySize: null,
              companyLinkedinUrl: null,
            },
          ],
          leadCount: 1,
          verifiedCount: 1,
          hasMore: false,
        });
      throw new Error("unexpected url " + u);
    });
    const id = await createAudience("apify", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("exhausted");
  });
});

describe("a standing opt-out on the crm serve path", () => {
  it("skips the contact and asks crm-service for the next one", async () => {
    standingOptOuts = ["stopper@acme.com"];
    const served: string[] = [];
    let call = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (isOptOutUrl(u)) return ok(optOutResponse(u, standingOptOuts));
      if (u.endsWith("/serve-next")) {
        const contact =
          call === 0
            ? { id: "c1", primaryEmail: "stopper@acme.com", phoneE164: null, fullName: "S", firstName: "S", lastName: null }
            : { id: "c2", primaryEmail: "willing@acme.com", phoneE164: null, fullName: "W", firstName: "W", lastName: null };
        call += 1;
        served.push(contact.primaryEmail);
        return ok({ contacts: [contact], served: 1, exhausted: false });
      }
      throw new Error("unexpected url " + u);
    });
    const id = await createAudience("crm", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.person.email).toBe("willing@acme.com");
    expect(served).toEqual(["stopper@acme.com", "willing@acme.com"]);
  });
});
