import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Every revealed address reads as deliverable: verification is its own suite.
vi.mock("../../src/lib/email-verification.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readEmailVerification: (_p: string, _r: unknown, email: string | null | undefined) =>
    email ? { verdict: "valid", deliverable: true } : null,
}));
// The brand under test is CERN: website home.cern, name "CERN", rep at cern.ch.
const brandIdentity = vi.fn();
vi.mock("../../src/lib/brand-identity.js", () => ({
  getBrandIdentity: (...args: unknown[]) => brandIdentity(...args),
}));
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { serveApollo } from "../helpers/serve-apollo.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { isOptOutUrl, optOutResponse, setOptOutEnv } from "../helpers/opt-outs.js";
import { bounceResponse, isBounceUrl } from "../helpers/bounces.js";
import { isWonLeadsUrl, setWonLeadsEnv, wonLeadsResponse } from "../helpers/won-leads.js";
import { db } from "../../src/db/index.js";
import { audiencePreviewCompanies, audiences } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { clearOwnCompanyCache } from "../../src/services/own-company.js";
import { BrandServiceError } from "../../src/lib/brand-offers.js";

// A brand never prospects its own company (owner, 2026-10-06). The fixture is
// the prod case: a CERN audience whose search returns CERN's own staff.

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000ce";
const APOLLO_AUD = "apollo-aud-cern";
const fetchSpy = vi.fn();
const fetchBefore = globalThis.fetch;

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

beforeEach(async () => {
  vi.stubGlobal("fetch", async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (isOptOutUrl(u)) return ok(optOutResponse(u, []));
    if (isBounceUrl(u)) return ok(bounceResponse(init?.body, []));
    if (isWonLeadsUrl(u)) return ok(wonLeadsResponse(u, {}));
    return fetchSpy(url, init);
  });
  fetchSpy.mockReset();
  clearOwnCompanyCache();
  brandIdentity.mockReset();
  brandIdentity.mockResolvedValue({
    id: BRAND,
    domain: "home.cern",
    url: "https://home.cern",
    name: "CERN",
    salesRepEmail: "rep@cern.ch",
  });
  setOptOutEnv();
  setWonLeadsEnv();
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.CRM_SERVICE_URL = "http://crm:8080";
  process.env.CRM_SERVICE_API_KEY = "crm-key";
  await cleanTestData();
});

afterAll(async () => {
  globalThis.fetch = fetchBefore;
  await closeDb();
});

async function createAudience(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({ brandId: BRAND, name, provider: "apollo", filters: { titles: ["Director"] }, ...extra });
  expect(res.status).toBe(201);
  return res.body.audience.id as string;
}

// --- serve-next -------------------------------------------------------------

function teaser(id: string, org: { name: string | null; domain: string | null }) {
  return {
    id,
    firstName: "S",
    lastName: null,
    name: null,
    email: null,
    emailStatus: null,
    title: "Director of Research and Computing",
    headline: null,
    seniority: "director",
    linkedinUrl: `https://www.linkedin.com/in/${id}`,
    photoUrl: null,
    city: null,
    state: null,
    country: null,
    organizationName: org.name,
    organizationDomain: org.domain,
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

// `teasers`: id → employer as the FREE teaser shows it; `emails`: id → the
// address the paid reveal returns.
function mockApollo(
  teasers: Record<string, { name: string | null; domain: string | null }>,
  emails: Record<string, string>
) {
  const enriched: string[] = [];
  let served = false;
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/search/next")) {
      const ids = served ? [] : Object.keys(teasers);
      served = true;
      return ok({ people: ids.map((id) => teaser(id, teasers[id])), done: ids.length === 0, totalEntries: ids.length });
    }
    if (u.endsWith("/enrich")) {
      const id = (JSON.parse(init.body ?? "{}") as { apolloPersonId?: string }).apolloPersonId ?? "";
      enriched.push(id);
      return ok({ person: { ...teaser(id, teasers[id]), lastName: "D", name: "S D", email: emails[id], emailStatus: "verified" } });
    }
    throw new Error("unexpected url " + u);
  });
  return { enriched };
}

describe("the apollo serve path (candidate API) never serves the brand's own staff", () => {
  it("drops a CERN teaser BEFORE the reveal (employer name) and serves the prospect", async () => {
    const calls = mockApollo(
      { cern1: { name: "CERN", domain: null }, infn1: { name: "INFN", domain: "infn.it" } },
      { cern1: "s@cern.ch", infn1: "r@infn.it" }
    );
    const id = await createAudience("Physics directors");

    const res = await serveApollo(app, id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("r@infn.it");
    expect(calls.enriched).toEqual(["infn1"]);
    expect(brandIdentity).toHaveBeenCalledWith(BRAND, expect.any(String));
  });

  it("drops a teaser on a subdomain of the brand's domain before the reveal", async () => {
    const calls = mockApollo(
      { cern2: { name: "ATLAS Experiment", domain: "atlas.home.cern" }, infn1: { name: "INFN", domain: "infn.it" } },
      { cern2: "a@home.cern", infn1: "r@infn.it" }
    );
    const id = await createAudience("Physics directors 2");
    const res = await serveApollo(app, id);
    expect(res.body.person.email).toBe("r@infn.it");
    expect(calls.enriched).toEqual(["infn1"]);
  });

  it("drops a person whose REVEALED work email is the brand's sibling domain, then serves the next", async () => {
    // The teaser names no employer; only the reveal shows rep-domain cern.ch.
    const calls = mockApollo(
      { hidden: { name: null, domain: null }, infn1: { name: "INFN", domain: "infn.it" } },
      { hidden: "x@cern.ch", infn1: "r@infn.it" }
    );
    const id = await createAudience("Physics directors 3");
    const res = await serveApollo(app, id);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("r@infn.it");
    expect(calls.enriched).toEqual(["hidden", "infn1"]);
  });

  it("only CERN staff in the pool ⟹ exhausted, nobody served", async () => {
    mockApollo({ cern1: { name: "CERN", domain: "home.cern" } }, { cern1: "s@home.cern" });
    const id = await createAudience("Only CERN");
    const res = await serveApollo(app, id);
    expect(res.body).toEqual({ status: "exhausted", person: null });
  });

  it("fails loud (502) when brand-service cannot say which company the brand is", async () => {
    brandIdentity.mockRejectedValue(new BrandServiceError(500, "boom"));
    mockApollo({ infn1: { name: "INFN", domain: "infn.it" } }, { infn1: "r@infn.it" });
    const id = await createAudience("Brand down");
    const res = await serveApollo(app, id);
    expect(res.status).toBe(502);
    expect(res.body.source).toBe("brand-service");
  });
});

// --- preview companies ------------------------------------------------------

function apolloCompany(rank: number, name: string, domain: string) {
  return {
    rank,
    name,
    apolloOrganizationId: `org-${rank}`,
    domain,
    websiteUrl: `http://${domain}`,
    logoUrl: null,
    linkedinUrl: null,
    shortDescription: null,
    industry: "research",
    estimatedNumEmployees: 1000,
    city: null,
    state: null,
    country: null,
    foundedYear: null,
    annualRevenuePrinted: null,
    totalFundingPrinted: null,
    latestFundingStage: null,
    keywords: [],
    peopleInSample: 1,
    person: { apolloPersonId: `person-${rank}`, firstName: "Sergio", lastNameObfuscated: "Be***", title: "Director of Research and Computing" },
  };
}

const LABS: Array<[string, string]> = [
  ["INFN", "infn.it"],
  ["Nikhef", "nikhef.nl"],
  ["CERN", "home.cern"],
  ["DEMOKRITOS", "demokritos.gr"],
  ["CERN IT", "it.cern.ch"],
  ["Heidelberg University", "uni-heidelberg.de"],
];

function mockCompanies() {
  fetchSpy.mockImplementation(async (url: string) => {
    const u = new URL(String(url));
    if (u.pathname === `/audiences/${APOLLO_AUD}/companies`) {
      const offset = Number(u.searchParams.get("offset"));
      const limit = Number(u.searchParams.get("limit"));
      const slice = LABS.slice(offset, offset + limit);
      return ok({
        apolloAudienceId: APOLLO_AUD,
        count: 900,
        offset,
        limit,
        companies: slice.map(([n, d], i) => apolloCompany(offset + i + 1, n, d)),
        hasMore: offset + limit < LABS.length,
        creditsCharged: slice.length,
      });
    }
    if (u.pathname === `/audiences/${APOLLO_AUD}/preview`) {
      return ok({
        apolloAudienceId: APOLLO_AUD,
        count: 900,
        companies: [
          { name: "INFN", peopleInSample: 2 },
          { name: "CERN", peopleInSample: 3 },
        ],
        people: [
          { firstName: "Sergio", lastNameObfuscated: "Be***", title: "Director", company: "CERN", apolloPersonId: "p1" },
          { firstName: "Rita", lastNameObfuscated: "Ro***", title: "Director", company: "INFN", apolloPersonId: "p2" },
        ],
      });
    }
    throw new Error("unexpected url " + u);
  });
}

describe("the onboarding preview never lists the brand's own company", () => {
  it("preview companies: CERN rows (domain and sibling domain) are never stored nor listed", async () => {
    mockCompanies();
    const id = await createAudience("Lab directors", { apolloAudienceId: APOLLO_AUD });
    const res = await request(app)
      .get(`/orgs/audiences/${id}/preview/companies?limit=25`)
      .set(getAuthHeaders());
    expect(res.status).toBe(200);
    const domains = res.body.rows.map((r: { company: { domain: string } }) => r.company.domain);
    expect(domains).toEqual(["infn.it", "nikhef.nl", "demokritos.gr", "uni-heidelberg.de"]);
    expect(res.body.totalAvailable).toBe(4);
    const stored = await db
      .select()
      .from(audiencePreviewCompanies)
      .where(eq(audiencePreviewCompanies.audienceId, id));
    expect(stored.map((s) => (s.company as { domain: string }).domain)).not.toContain("home.cern");
  });

  it("a CERN row stored before the rule is hidden on read and cannot be email-checked", async () => {
    mockCompanies();
    const id = await createAudience("Legacy rows", { apolloAudienceId: APOLLO_AUD });
    await db.insert(audiencePreviewCompanies).values([
      { audienceId: id, idx: 0, company: { name: "INFN", domain: "infn.it" }, person: { providerPersonId: "p0" } },
      { audienceId: id, idx: 1, company: { name: "CERN", domain: "home.cern" }, person: { providerPersonId: "p1" } },
    ]);
    await db
      .update(audiences)
      .set({ previewCompaniesState: { apolloOffset: 2, done: true, matchCount: 2 } })
      .where(eq(audiences.id, id));

    const res = await request(app).get(`/orgs/audiences/${id}/preview/companies`).set(getAuthHeaders());
    expect(res.body.rows.map((r: { company: { name: string } }) => r.company.name)).toEqual(["INFN"]);
    expect(res.body.totalAvailable).toBe(1);

    const check = await request(app)
      .post(`/orgs/audiences/${id}/preview/companies/1/email-check`)
      .set(getAuthHeaders());
    expect(check.status).toBe(404);
  });

  it("preview sample: CERN is neither a company nor a person's employer", async () => {
    mockCompanies();
    const id = await createAudience("Sample", { apolloAudienceId: APOLLO_AUD });
    const res = await request(app).get(`/orgs/audiences/${id}/preview`).set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.companies).toEqual([{ name: "INFN", peopleInSample: 2 }]);
    expect(res.body.people.map((p: { company: string }) => p.company)).toEqual(["INFN"]);
  });
});
