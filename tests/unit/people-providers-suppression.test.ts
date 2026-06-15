import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the suppression layer so we test the people-gateway WIRING (does it call
// filter / exclude-set / record / block at the right moments?) without a db.
const supp = vi.hoisted(() => ({
  filterSuppressed: vi.fn(),
  getSuppressionSet: vi.fn(),
  isEmailSuppressed: vi.fn(),
  recordServe: vi.fn(),
}));
vi.mock("../../src/services/suppression.js", () => supp);

import {
  peopleSearch,
  resolveEmail,
} from "../../src/services/people-providers.js";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

const apolloPerson = (id: string, linkedin: string | null) => ({
  id,
  firstName: "Sara",
  lastName: "F",
  name: "Sara F",
  email: null,
  emailStatus: null,
  title: "Founder",
  headline: null,
  seniority: "founder",
  linkedinUrl: linkedin,
  photoUrl: null,
  city: null,
  state: null,
  country: null,
  organizationName: "Casco",
  organizationDomain: "casco.com",
  organizationWebsiteUrl: null,
  organizationIndustry: null,
  organizationSize: null,
  organizationLinkedinUrl: null,
  organizationLogoUrl: null,
  organizationCity: null,
  organizationState: null,
  organizationCountry: null,
});

const apifyLead = (email: string, linkedin: string | null) => ({
  firstName: "Jane",
  lastName: "Doe",
  fullName: "Jane Doe",
  title: "CTO",
  seniority: "c_suite",
  email,
  emailStatus: "verified",
  source: "pipelinelabs",
  isCatchAll: false,
  isInferred: false,
  linkedinUrl: linkedin,
  city: null,
  state: null,
  country: null,
  companyName: "Acme",
  companyDomain: "acme.com",
  companyIndustry: null,
  companySize: null,
  companyLinkedinUrl: null,
});

const baseIdentity = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const brandIdentity = { ...baseIdentity, brandIds: ["brand-A"], campaignId: "camp-1" };

beforeEach(() => {
  fetchSpy.mockReset();
  supp.filterSuppressed.mockReset().mockImplementation(async (_o, _b, items) => items);
  supp.getSuppressionSet.mockReset().mockResolvedValue({ emails: [], linkedinUrls: [] });
  supp.isEmailSuppressed.mockReset().mockResolvedValue(false);
  supp.recordServe.mockReset().mockResolvedValue(undefined);
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.APIFY_SERVICE_URL = "http://apify:8080";
  process.env.APIFY_SERVICE_API_KEY = "apify-key";
});

afterEach(() => vi.restoreAllMocks());

describe("apollo search — suppression filter", () => {
  it("no brandIds → does NOT filter, single page", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ people: [apolloPerson("a1", "https://linkedin.com/in/sara")], done: false, totalEntries: 9 })
    );
    const r = await peopleSearch({ provider: "apollo", filters: {}, identity: baseIdentity });
    expect(supp.filterSuppressed).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.people).toHaveLength(1);
  });

  it("with brandIds → passes teasers through filterSuppressed", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ people: [apolloPerson("a1", "https://linkedin.com/in/sara")], done: false, totalEntries: 9 })
    );
    const r = await peopleSearch({ provider: "apollo", filters: {}, identity: brandIdentity });
    expect(supp.filterSuppressed).toHaveBeenCalledWith("org-1", ["brand-A"], expect.any(Array));
    expect(r.people).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // got a fresh lead → no extra paging
  });

  it("saturated brand (every page all-suppressed) → bounded re-page → done:true, no leads", async () => {
    fetchSpy.mockResolvedValue(
      ok({ people: [apolloPerson("a1", "https://linkedin.com/in/sara")], done: false, totalEntries: 9999 })
    );
    supp.filterSuppressed.mockResolvedValue([]); // everything already served
    const r = await peopleSearch({ provider: "apollo", filters: {}, identity: brandIdentity });
    expect(r.people).toHaveLength(0);
    expect(r.done).toBe(true); // terminal on saturation
    expect(fetchSpy).toHaveBeenCalledTimes(5); // APOLLO_MAX_SATURATION_PAGES
  });

  it("respects apollo's own done before exhausting the page budget", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ people: [], done: true, totalEntries: 9 }));
    supp.filterSuppressed.mockResolvedValue([]);
    const r = await peopleSearch({ provider: "apollo", filters: {}, identity: brandIdentity });
    expect(r.done).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("apify search — exclude-set push + record", () => {
  it("with brandIds → sends excludeEmails / excludeLinkedinUrls + records serves", async () => {
    supp.getSuppressionSet.mockResolvedValue({
      emails: ["old@served.com"],
      linkedinUrls: ["linkedin.com/in/old"],
    });
    fetchSpy.mockResolvedValueOnce(
      ok({ searchId: "s", leadCount: 1, verifiedCount: 1, hasMore: false, leads: [apifyLead("jane@acme.com", "https://linkedin.com/in/jane")] })
    );
    const r = await peopleSearch({ provider: "apify", filters: {}, limit: 5, identity: brandIdentity });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.excludeEmails).toEqual(["old@served.com"]);
    expect(body.excludeLinkedinUrls).toEqual(["linkedin.com/in/old"]);
    expect(supp.recordServe).toHaveBeenCalledTimes(1);
    const [org, brands, contacts, ctx] = supp.recordServe.mock.calls[0];
    expect(org).toBe("org-1");
    expect(brands).toEqual(["brand-A"]);
    expect(contacts[0].email).toBe("jane@acme.com");
    expect(ctx.campaignId).toBe("camp-1");
    expect(r.people).toHaveLength(1);
  });

  it("no brandIds → no exclude fields, no record", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ searchId: "s", leadCount: 1, verifiedCount: 1, hasMore: false, leads: [apifyLead("x@y.com", null)] })
    );
    await peopleSearch({ provider: "apify", filters: {}, identity: baseIdentity });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.excludeEmails).toBeUndefined();
    expect(body.excludeLinkedinUrls).toBeUndefined();
    expect(supp.getSuppressionSet).not.toHaveBeenCalled();
    expect(supp.recordServe).not.toHaveBeenCalled();
  });
});

describe("resolve-email — block + record", () => {
  const enrichOk = ok({
    enrichmentId: "e1",
    cached: false,
    person: {
      id: "a1", firstName: "Jane", lastName: "Doe", name: "Jane Doe",
      email: "jane@acme.com", emailStatus: "verified", title: null, headline: null,
      seniority: null, linkedinUrl: null, photoUrl: null, city: null, state: null, country: null,
      organizationName: null, organizationDomain: "acme.com", organizationWebsiteUrl: null,
      organizationIndustry: null, organizationSize: null, organizationLinkedinUrl: null,
      organizationLogoUrl: null, organizationCity: null, organizationState: null, organizationCountry: null,
    },
  });

  it("not suppressed → records serve + returns person", async () => {
    fetchSpy.mockResolvedValueOnce(enrichOk);
    const r = await resolveEmail({ providerPersonId: "a1", identity: brandIdentity });
    expect(supp.isEmailSuppressed).toHaveBeenCalledWith("org-1", ["brand-A"], "jane@acme.com");
    expect(supp.recordServe).toHaveBeenCalledTimes(1);
    expect(r.person?.email).toBe("jane@acme.com");
  });

  it("suppressed (residual cross-provider edge) → person:null, NOT recorded", async () => {
    fetchSpy.mockResolvedValueOnce(enrichOk);
    supp.isEmailSuppressed.mockResolvedValue(true);
    const r = await resolveEmail({ providerPersonId: "a1", identity: brandIdentity });
    expect(r.person).toBeNull();
    expect(supp.recordServe).not.toHaveBeenCalled();
  });

  it("no brandIds → no block, no record (unchanged behavior)", async () => {
    fetchSpy.mockResolvedValueOnce(enrichOk);
    const r = await resolveEmail({ providerPersonId: "a1", identity: baseIdentity });
    expect(supp.isEmailSuppressed).not.toHaveBeenCalled();
    expect(supp.recordServe).not.toHaveBeenCalled();
    expect(r.person?.email).toBe("jane@acme.com");
  });
});
