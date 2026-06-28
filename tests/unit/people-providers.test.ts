import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveProvider,
  apolloEmployeeRanges,
  peopleSearch,
  resolveEmail,
  dryRun,
  filtersPrompt,
  ProviderError,
  ProviderConfigError,
  ProviderUnsupportedError,
} from "../../src/services/people-providers.js";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

const identity = { orgId: "org-1", userId: "user-1", runId: "run-1" };

beforeEach(() => {
  fetchSpy.mockReset();
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.APIFY_SERVICE_URL = "http://apify:8080";
  process.env.APIFY_SERVICE_API_KEY = "apify-key";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveProvider", () => {
  it("explicit provider wins over need", () => {
    expect(resolveProvider({ provider: "apify", need: "verified_email" })).toBe("apify");
    expect(resolveProvider({ provider: "apollo", need: "verified_email" })).toBe("apollo");
  });
  it("need verified_email defaults to apollo (apollo-only — apify no longer auto-selected)", () => {
    expect(resolveProvider({ need: "verified_email" })).toBe("apollo");
  });
  it("defaults to apollo", () => {
    expect(resolveProvider({})).toBe("apollo");
  });
});

describe("apolloEmployeeRanges", () => {
  it("maps a window to overlapping buckets", () => {
    expect(apolloEmployeeRanges(11, 100)).toEqual(["11,20", "21,50", "51,100"]);
  });
  it("open-ended max includes the top bucket", () => {
    expect(apolloEmployeeRanges(6000)).toContain("10001,");
    expect(apolloEmployeeRanges(6000)).toContain("5001,10000");
  });
  it("returns [] when no bounds", () => {
    expect(apolloEmployeeRanges()).toEqual([]);
  });
});

describe("peopleSearch — apollo", () => {
  it("forwards mapped searchParams + identity + campaign header to /search/next", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({
        people: [
          {
            id: "apollo-1",
            firstName: "Sara",
            lastName: "Freshley",
            name: "Sara Freshley",
            email: "sara@cascobay.com",
            emailStatus: "verified",
            title: "Founder",
            headline: "Founder at Casco Bay",
            seniority: "founder",
            linkedinUrl: "https://linkedin.com/in/sara",
            photoUrl: null,
            city: "Portland",
            state: "ME",
            country: "USA",
            organizationName: "Casco Bay",
            organizationDomain: "cascobay.com",
            organizationWebsiteUrl: "https://cascobay.com",
            organizationIndustry: "marketing",
            organizationSize: "12",
            organizationAnnualRevenue: 5000000,
            organizationLinkedinUrl: null,
            organizationLogoUrl: null,
            organizationCity: "Portland",
            organizationState: "ME",
            organizationCountry: "USA",
          },
        ],
        done: false,
        totalEntries: 873,
      })
    );

    const result = await peopleSearch({
      provider: "apollo",
      filters: {
        titles: ["Founder"],
        seniorities: ["founder"],
        industries: ["marketing"],
        companyDomains: ["cascobay.com"],
        keywords: ["agency", "branding"],
        employeeMin: 11,
        employeeMax: 100,
      },
      identity: { ...identity, campaignId: "camp-9" },
    });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://apollo:8080/search/next");
    expect(opts.headers["X-API-Key"]).toBe("apollo-key");
    expect(opts.headers["x-org-id"]).toBe("org-1");
    expect(opts.headers["x-run-id"]).toBe("run-1");
    expect(opts.headers["x-campaign-id"]).toBe("camp-9");

    const body = JSON.parse(opts.body);
    expect(body.searchParams.personTitles).toEqual(["Founder"]);
    expect(body.searchParams.personSeniorities).toEqual(["founder"]);
    expect(body.searchParams.qOrganizationIndustryTagIds).toEqual(["marketing"]);
    expect(body.searchParams.qOrganizationDomains).toEqual(["cascobay.com"]);
    expect(body.searchParams.qKeywords).toBe("agency OR branding");
    expect(body.searchParams.organizationNumEmployeesRanges).toEqual([
      "11,20",
      "21,50",
      "51,100",
    ]);

    // Normalized output
    expect(result.provider).toBe("apollo");
    expect(result.done).toBe(false);
    expect(result.total).toBe(873);
    const p = result.people[0];
    expect(p.firstName).toBe("Sara");
    expect(p.email).toBe("sara@cascobay.com");
    expect(p.emailStatus).toBe("verified");
    expect(p.provider).toBe("apollo");
    expect(p.providerPersonId).toBe("apollo-1");
    expect(p.organization?.domain).toBe("cascobay.com");
    expect(p.organization?.estimatedNumEmployees).toBe(12);
    expect(p.organization?.annualRevenue).toBe(5000000);
  });

  it("organization.annualRevenue is null when apollo omits organizationAnnualRevenue", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({
        people: [
          {
            id: "apollo-2",
            firstName: "Ada",
            lastName: "Byte",
            name: "Ada Byte",
            email: "ada@nrco.com",
            emailStatus: "verified",
            title: "CEO",
            headline: null,
            seniority: "founder",
            linkedinUrl: null,
            photoUrl: null,
            city: null,
            state: null,
            country: null,
            organizationName: "No Rev Co",
            organizationDomain: "nrco.com",
            organizationWebsiteUrl: null,
            organizationIndustry: "software",
            organizationSize: "30",
            organizationAnnualRevenue: null,
            organizationLinkedinUrl: null,
            organizationLogoUrl: null,
            organizationCity: null,
            organizationState: null,
            organizationCountry: null,
          },
        ],
        done: true,
        totalEntries: 1,
      })
    );
    const result = await peopleSearch({ provider: "apollo", filters: {}, identity });
    expect(result.people[0].organization?.annualRevenue).toBeNull();
  });

  it("nextPage sends an empty body so apollo advances its cursor", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ people: [], done: true, totalEntries: 0 }));
    await peopleSearch({ provider: "apollo", filters: {}, isNextPage: true, identity });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({});
  });

  it("forwards x-audience-id (tracking block) to apollo for cost attribution", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ people: [], done: true, totalEntries: 0 }));
    await peopleSearch({
      provider: "apollo",
      filters: {},
      identity: {
        ...identity,
        campaignId: "camp-9",
        workflowTracking: { audienceId: "aud-789" },
      },
    });
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["x-audience-id"]).toBe("aud-789");
  });

  it("emits no x-audience-id when the tracking block is absent", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ people: [], done: true, totalEntries: 0 }));
    await peopleSearch({ provider: "apollo", filters: {}, identity });
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["x-audience-id"]).toBeUndefined();
  });
});

describe("peopleSearch — apify", () => {
  it("sends flat filters + limit, normalizes leads, done=true", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({
        searchId: "s-1",
        leadCount: 2,
        verifiedCount: 2,
        leads: [
          {
            firstName: "Jane",
            lastName: "Doe",
            fullName: "Jane Doe",
            title: "CTO",
            seniority: "c_suite",
            email: "jane@acme.com",
            emailStatus: "verified",
            source: "pipelinelabs",
            isCatchAll: false,
            isInferred: false,
            linkedinUrl: null,
            city: null,
            state: null,
            country: null,
            companyName: "Acme",
            companyDomain: "acme.com",
            companyIndustry: "software",
            companySize: 50,
            companyLinkedinUrl: null,
          },
        ],
      })
    );

    const result = await peopleSearch({
      // apify is no longer auto-selected via `need` — exercise its branch via an
      // explicit provider (still honored for existing apify audiences).
      provider: "apify",
      filters: { titles: ["CTO"], functions: ["engineering"], companyNames: ["Acme"], employeeMin: 10 },
      limit: 25,
      identity,
    });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://apify:8080/search");
    expect(opts.headers["X-API-Key"]).toBe("apify-key");
    const body = JSON.parse(opts.body);
    expect(body.limit).toBe(25);
    expect(body.titles).toEqual(["CTO"]);
    expect(body.functions).toEqual(["engineering"]);
    expect(body.companyNames).toEqual(["Acme"]);
    expect(body.employeeMin).toBe(10);

    expect(result.provider).toBe("apify");
    expect(result.done).toBe(true);
    expect(result.total).toBe(2);
    const p = result.people[0];
    expect(p.name).toBe("Jane Doe");
    expect(p.email).toBe("jane@acme.com");
    expect(p.catchAll).toBe(false);
    expect(p.inferred).toBe(false);
    expect(p.provider).toBe("apify");
    expect(p.providerPersonId).toBeNull();
    expect(p.organization?.estimatedNumEmployees).toBe(50);
    // apify returns no revenue field → always null
    expect(p.organization?.annualRevenue).toBeNull();
  });

  it("defaults limit to 1 (strict minimum — apify bills per returned lead) when omitted", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ searchId: "s", leadCount: 0, verifiedCount: 0, leads: [] }));
    await peopleSearch({ provider: "apify", filters: {}, identity });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.limit).toBe(1);
  });

  it("forwards offset + maps totalMatched/hasMore/nextOffset", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ searchId: "s", leadCount: 1, verifiedCount: 1, totalMatched: 5000, hasMore: true, nextOffset: 200, leads: [] })
    );
    const result = await peopleSearch({ provider: "apify", filters: {}, limit: 100, offset: 100, identity });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).offset).toBe(100);
    expect(result.total).toBe(5000);
    expect(result.done).toBe(false);
    expect(result.nextOffset).toBe(200);
  });

  it("done=true + nextOffset null when hasMore false", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ searchId: "s", leadCount: 3, verifiedCount: 3, totalMatched: 3, hasMore: false, leads: [] })
    );
    const result = await peopleSearch({ provider: "apify", filters: {}, identity });
    expect(result.done).toBe(true);
    expect(result.nextOffset).toBeNull();
    expect(result.total).toBe(3);
  });

  it("maps rich filters to apify verbatim", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ searchId: "s", leadCount: 0, verifiedCount: 0, leads: [] }));
    await peopleSearch({
      provider: "apify",
      filters: { companySizes: ["11-50"], revenueRanges: ["1M-10M"], fundingStages: ["seed"], technologies: ["hubspot"] },
      identity,
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.companySizes).toEqual(["11-50"]);
    expect(body.revenueRanges).toEqual(["1M-10M"]);
    expect(body.fundingStages).toEqual(["seed"]);
    expect(body.technologies).toEqual(["hubspot"]);
  });

  it("maps rich filters to apollo where equivalent (revenue, technologies)", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ people: [], done: true, totalEntries: 0 }));
    await peopleSearch({
      provider: "apollo",
      filters: { revenueRanges: ["1000000,10000000"], technologies: ["salesforce"], fundingStages: ["seed"] },
      identity,
    });
    const sp = JSON.parse(fetchSpy.mock.calls[0][1].body).searchParams;
    expect(sp.revenueRange).toEqual(["1000000,10000000"]);
    expect(sp.currentlyUsingAnyOfTechnologyUids).toEqual(["salesforce"]);
    expect(sp.fundingStages).toBeUndefined(); // apollo has no funding-stage search filter
  });
});

const apolloPersonOk = (overrides: Record<string, unknown> = {}) =>
  ok({
    enrichmentId: "e1",
    cached: false,
    person: {
      id: "a1",
      firstName: "Jane",
      lastName: "Doe",
      name: "Jane Doe",
      email: "jane@acme.com",
      emailStatus: "verified",
      title: null,
      headline: null,
      seniority: null,
      linkedinUrl: null,
      photoUrl: null,
      city: null,
      state: null,
      country: null,
      organizationName: null,
      organizationDomain: "acme.com",
      organizationWebsiteUrl: null,
      organizationIndustry: null,
      organizationSize: null,
      organizationLinkedinUrl: null,
      organizationLogoUrl: null,
      organizationCity: null,
      organizationState: null,
      organizationCountry: null,
    },
    ...overrides,
  });

describe("resolveEmail", () => {
  it("defaults to apollo /enrich by providerPersonId (the billed reveal path)", async () => {
    fetchSpy.mockResolvedValueOnce(apolloPersonOk());
    const result = await resolveEmail({ providerPersonId: "a1", identity });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://apollo:8080/enrich");
    expect(JSON.parse(opts.body)).toEqual({ apolloPersonId: "a1" });
    expect(result.provider).toBe("apollo");
    expect(result.person?.email).toBe("jane@acme.com");
    expect(result.person?.providerPersonId).toBe("a1");
  });

  it("provider=apollo + providerPersonId routes to /enrich", async () => {
    fetchSpy.mockResolvedValueOnce(apolloPersonOk());
    const result = await resolveEmail({
      provider: "apollo",
      providerPersonId: "a1",
      identity,
    });
    expect(fetchSpy.mock.calls[0][0]).toBe("http://apollo:8080/enrich");
    expect(result.person?.email).toBe("jane@acme.com");
  });

  it("apollo /enrich returns person=null when apollo reveals nothing", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ enrichmentId: null, cached: false, person: null }));
    const result = await resolveEmail({ providerPersonId: "a1", identity });
    expect(result.provider).toBe("apollo");
    expect(result.person).toBeNull();
  });

  it("provider=apify + providerPersonId only fails loud (no person-id enrich on apify)", async () => {
    await expect(
      resolveEmail({ provider: "apify", providerPersonId: "a1", identity })
    ).rejects.toBeInstanceOf(ProviderUnsupportedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("provider=apify + name+domain routes to /resolve", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({
        searchId: "s",
        requested: 1,
        resolvedCount: 1,
        leads: [
          {
            firstName: "Jane",
            lastName: "Doe",
            fullName: "Jane Doe",
            title: null,
            seniority: null,
            email: "jane@acme.com",
            emailStatus: "verified",
            source: "microworlds",
            isCatchAll: false,
            isInferred: false,
            linkedinUrl: null,
            city: null,
            state: null,
            country: null,
            companyName: null,
            companyDomain: "acme.com",
            companyIndustry: null,
            companySize: null,
            companyLinkedinUrl: null,
          },
        ],
      })
    );
    const result = await resolveEmail({
      provider: "apify",
      firstName: "Jane",
      lastName: "Doe",
      domain: "acme.com",
      identity,
    });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://apify:8080/resolve");
    const body = JSON.parse(opts.body);
    expect(body.leads[0]).toEqual({ firstName: "Jane", lastName: "Doe", companyDomain: "acme.com" });
    expect(result.provider).toBe("apify");
    expect(result.person?.email).toBe("jane@acme.com");
  });

  it("provider=apollo + name+domain (no person id) falls back to /match", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ enrichmentId: "e1", cached: false, person: { id: "a1", firstName: "Jane", lastName: "Doe", name: "Jane Doe", email: "jane@acme.com", emailStatus: "verified", title: null, headline: null, seniority: null, linkedinUrl: null, photoUrl: null, city: null, state: null, country: null, organizationName: null, organizationDomain: "acme.com", organizationWebsiteUrl: null, organizationIndustry: null, organizationSize: null, organizationLinkedinUrl: null, organizationLogoUrl: null, organizationCity: null, organizationState: null, organizationCountry: null } })
    );
    const result = await resolveEmail({
      provider: "apollo",
      firstName: "Jane",
      lastName: "Doe",
      domain: "acme.com",
      identity,
    });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://apollo:8080/match");
    expect(JSON.parse(opts.body).organizationDomain).toBe("acme.com");
    expect(result.provider).toBe("apollo");
    expect(result.person?.providerPersonId).toBe("a1");
  });

  it("returns person=null when apollo /match finds nothing", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ enrichmentId: null, cached: false, person: null }));
    const result = await resolveEmail({ firstName: "No", lastName: "One", domain: "x.com", identity });
    expect(fetchSpy.mock.calls[0][0]).toBe("http://apollo:8080/match");
    expect(result.provider).toBe("apollo");
    expect(result.person).toBeNull();
  });
});

describe("dryRun", () => {
  it("apollo returns totalEntries", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ totalEntries: 5000, validationErrors: [] }));
    const result = await dryRun({ provider: "apollo", filters: { titles: ["CEO"] }, identity });
    expect(fetchSpy.mock.calls[0][0]).toBe("http://apollo:8080/search/dry-run");
    expect(result.totalEntries).toBe(5000);
  });
  it("apify routes to /search/count → totalEntries", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ totalMatched: 8421 }));
    const result = await dryRun({ provider: "apify", filters: { titles: ["CEO"] }, identity });
    expect(fetchSpy.mock.calls[0][0]).toBe("http://apify:8080/search/count");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.limit).toBeUndefined(); // count has no limit
    expect(body.titles).toEqual(["CEO"]);
    expect(result.provider).toBe("apify");
    expect(result.totalEntries).toBe(8421);
  });
});

describe("filtersPrompt", () => {
  it("apollo proxies prompt + schemaVersion", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ prompt: "## filters", schemaVersion: "abc123" }));
    const result = await filtersPrompt({ provider: "apollo", identity });
    expect(fetchSpy.mock.calls[0][0]).toBe("http://apollo:8080/search/filters-prompt");
    expect(result.prompt).toBe("## filters");
    expect(result.schemaVersion).toBe("abc123");
  });
  it("apify proxies its own filters-prompt", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ prompt: "## apify filters", schemaVersion: "apifyv1" }));
    const result = await filtersPrompt({ provider: "apify", identity });
    expect(fetchSpy.mock.calls[0][0]).toBe("http://apify:8080/search/filters-prompt");
    expect(result.provider).toBe("apify");
    expect(result.schemaVersion).toBe("apifyv1");
  });
});

describe("fail-loud", () => {
  it("throws ProviderError on non-ok upstream (no fallback)", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" });
    await expect(
      peopleSearch({ provider: "apollo", filters: {}, identity })
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws ProviderError when a transient failure persists past all retries", async () => {
    // ECONNRESET is transient → retried; a persistent reject exhausts retries
    // and surfaces as a ProviderError (still fail-loud, no fallback).
    fetchSpy.mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      peopleSearch({ provider: "apify", filters: {}, identity })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetchSpy).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("throws ProviderConfigError when provider env is missing", async () => {
    delete process.env.APOLLO_SERVICE_URL;
    await expect(
      peopleSearch({ provider: "apollo", filters: {}, identity })
    ).rejects.toBeInstanceOf(ProviderConfigError);
  });
});

describe("cold-start connect retry", () => {
  it("retries a transient 'fetch failed' (Neon sibling wake) then succeeds", async () => {
    const transient = new TypeError("fetch failed");
    (transient as { cause?: unknown }).cause = { code: "ECONNRESET" };
    fetchSpy
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(ok({ people: [], done: true, totalEntries: 0 }));

    const result = await peopleSearch({ provider: "apollo", filters: {}, identity });
    expect(result.total).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a non-transient throw", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("boom"));
    await expect(
      peopleSearch({ provider: "apollo", filters: {}, identity })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a completed HTTP 5xx (real answer)", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}), text: async () => "down" });
    await expect(
      peopleSearch({ provider: "apollo", filters: {}, identity })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
