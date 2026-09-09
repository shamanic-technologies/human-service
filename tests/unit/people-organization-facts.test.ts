import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  peopleSearch,
  resolveEmail,
} from "../../src/services/people-providers.js";

// This suite is the guard for the organization facts + career history the
// provider already pays for: they must land on the neutral person INTACT and IN
// ORDER, and a provider response carrying none of them must still yield a valid
// person with those fields absent (null) rather than defaulted or synthesised.

const fetchSpy = vi.fn();

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

const identity = { orgId: "org-1", userId: "user-1", runId: "run-1" };

// A person as apollo-service actually serves it on /search/next and /enrich,
// carrying the whole organization + career payload.
const RICH_APOLLO_PERSON = {
  id: "apollo-rich-1",
  firstName: "Mira",
  lastName: "Feldt",
  name: "Mira Feldt",
  email: "mira@northwind.io",
  emailStatus: "verified",
  title: "Head of Operations",
  headline: "Head of Operations at Northwind",
  seniority: "director",
  linkedinUrl: "https://linkedin.com/in/mirafeldt",
  photoUrl: null,
  city: "Berlin",
  state: "Berlin",
  country: "Germany",
  timeZone: "Europe/Berlin",
  organizationId: "org-apollo-9",
  organizationName: "Northwind",
  organizationDomain: "northwind.io",
  organizationWebsiteUrl: "https://northwind.io",
  organizationIndustry: "logistics",
  organizationSize: "240",
  organizationAnnualRevenue: 41_000_000,
  organizationLinkedinUrl: "https://linkedin.com/company/northwind",
  organizationLogoUrl: "https://cdn.apollo.io/northwind.png",
  organizationCity: "Berlin",
  organizationState: "Berlin",
  organizationCountry: "Germany",
  organizationShortDescription: "Freight orchestration for mid-market shippers.",
  organizationSeoDescription: "Northwind moves freight without the phone calls.",
  organizationKeywords: ["freight", "logistics", "supply chain"],
  organizationIndustries: ["logistics", "transportation"],
  organizationSecondaryIndustries: ["software"],
  organizationTechnologyNames: ["Segment", "Snowflake", "Stripe"],
  organizationCurrentTechnologies: [
    { uid: "segment", name: "Segment", category: "analytics" },
    { uid: "stripe", name: "Stripe", category: "payments" },
  ],
  organizationFoundedYear: 2014,
  organizationAnnualRevenuePrinted: "$41M",
  organizationTotalFunding: "62000000",
  organizationTotalFundingPrinted: "$62M",
  organizationLatestFundingStage: "Series B",
  organizationLatestFundingRoundDate: "2024-03-11",
  organizationFundingEvents: [
    {
      id: "fe-2",
      date: "2024-03-11",
      type: "Series B",
      investors: "Index, Cherry",
      amount: 40_000_000,
      currency: "USD",
    },
    {
      id: "fe-1",
      date: "2021-06-02",
      type: "Series A",
      investors: "Cherry",
      amount: 12_000_000,
      currency: "USD",
    },
  ],
  organizationTwitterUrl: "https://twitter.com/northwind",
  organizationFacebookUrl: "https://facebook.com/northwind",
  organizationBlogUrl: "https://northwind.io/blog",
  organizationCrunchbaseUrl: "https://crunchbase.com/organization/northwind",
  organizationAngellistUrl: "https://angel.co/northwind",
  organizationPrimaryPhone: "+49 30 1234567",
  organizationPubliclyTradedSymbol: null,
  organizationPubliclyTradedExchange: null,
  organizationStreetAddress: "Chausseestrasse 5",
  organizationPostalCode: "10115",
  organizationRawAddress: "Chausseestrasse 5, 10115 Berlin, Germany",
  organizationNumSuborganizations: 2,
  organizationRetailLocationCount: 0,
  organizationAlexaRanking: 184_233,
  employmentHistory: [
    {
      title: "Head of Operations",
      organizationName: "Northwind",
      startDate: "2021-04-01",
      endDate: null,
      description: "Runs the ops org.",
      current: true,
    },
    {
      title: "Operations Manager",
      organizationName: "Rheinfracht",
      startDate: "2017-09-01",
      endDate: "2021-03-31",
      description: null,
      current: false,
    },
    {
      title: "Analyst",
      organizationName: "Deutsche Post",
      startDate: "2015-01-01",
      endDate: "2017-08-31",
      description: null,
      current: false,
    },
  ],
};

// The same person as a provider that serves none of that material: the shape
// human-service consumed before this feature existed.
const BARE_APOLLO_PERSON = {
  id: "apollo-bare-1",
  firstName: "Otto",
  lastName: "Kranz",
  name: "Otto Kranz",
  email: "otto@bare.example",
  emailStatus: "verified",
  title: "Owner",
  headline: null,
  seniority: "owner",
  linkedinUrl: null,
  photoUrl: null,
  city: null,
  state: null,
  country: null,
  organizationName: "Bare GmbH",
  organizationDomain: "bare.example",
  organizationWebsiteUrl: null,
  organizationIndustry: null,
  organizationSize: null,
  organizationAnnualRevenue: null,
  organizationLinkedinUrl: null,
  organizationLogoUrl: null,
  organizationCity: null,
  organizationState: null,
  organizationCountry: null,
};

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.APIFY_SERVICE_URL = "http://apify:8080";
  process.env.APIFY_SERVICE_API_KEY = "apify-key";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("organization facts + career history — apollo search", () => {
  it("lands the whole organization payload on the neutral person, in order", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ people: [RICH_APOLLO_PERSON], done: true, totalEntries: 1 })
    );
    const res = await peopleSearch({
      provider: "apollo",
      filters: { titles: ["Head of Operations"] },
      identity,
    });
    const org = res.people[0].organization!;

    // Everything that was already carried is untouched.
    expect(org.name).toBe("Northwind");
    expect(org.domain).toBe("northwind.io");
    expect(org.industry).toBe("logistics");
    expect(org.estimatedNumEmployees).toBe(240);
    expect(org.annualRevenue).toBe(41_000_000);

    // Descriptions, keywords, technologies, industries.
    expect(org.providerOrganizationId).toBe("org-apollo-9");
    expect(org.shortDescription).toBe(
      "Freight orchestration for mid-market shippers."
    );
    expect(org.seoDescription).toBe("Northwind moves freight without the phone calls.");
    expect(org.keywords).toEqual(["freight", "logistics", "supply chain"]);
    expect(org.industries).toEqual(["logistics", "transportation"]);
    expect(org.secondaryIndustries).toEqual(["software"]);
    expect(org.technologyNames).toEqual(["Segment", "Snowflake", "Stripe"]);
    expect(org.currentTechnologies).toEqual([
      { uid: "segment", name: "Segment", category: "analytics" },
      { uid: "stripe", name: "Stripe", category: "payments" },
    ]);

    // Funding + founding + revenue.
    expect(org.foundedYear).toBe(2014);
    expect(org.annualRevenuePrinted).toBe("$41M");
    expect(org.totalFunding).toBe("62000000");
    expect(org.totalFundingPrinted).toBe("$62M");
    expect(org.latestFundingStage).toBe("Series B");
    expect(org.latestFundingRoundDate).toBe("2024-03-11");
    expect(org.fundingEvents).toEqual([
      {
        id: "fe-2",
        date: "2024-03-11",
        type: "Series B",
        investors: "Index, Cherry",
        amount: 40_000_000,
        currency: "USD",
      },
      {
        id: "fe-1",
        date: "2021-06-02",
        type: "Series A",
        investors: "Cherry",
        amount: 12_000_000,
        currency: "USD",
      },
    ]);

    // Web / social / phone / address.
    expect(org.twitterUrl).toBe("https://twitter.com/northwind");
    expect(org.facebookUrl).toBe("https://facebook.com/northwind");
    expect(org.blogUrl).toBe("https://northwind.io/blog");
    expect(org.crunchbaseUrl).toBe("https://crunchbase.com/organization/northwind");
    expect(org.angellistUrl).toBe("https://angel.co/northwind");
    expect(org.primaryPhone).toBe("+49 30 1234567");
    expect(org.publiclyTradedSymbol).toBeNull();
    expect(org.publiclyTradedExchange).toBeNull();
    expect(org.streetAddress).toBe("Chausseestrasse 5");
    expect(org.postalCode).toBe("10115");
    expect(org.rawAddress).toBe("Chausseestrasse 5, 10115 Berlin, Germany");
    expect(org.numSuborganizations).toBe(2);
    expect(org.retailLocationCount).toBe(0);
    expect(org.alexaRanking).toBe(184_233);
  });

  it("carries the FULL career history in provider order, current role flagged", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ people: [RICH_APOLLO_PERSON], done: true, totalEntries: 1 })
    );
    const res = await peopleSearch({
      provider: "apollo",
      filters: { titles: ["Head of Operations"] },
      identity,
    });
    const history = res.people[0].employmentHistory!;

    expect(history).toHaveLength(3);
    expect(history.map((r) => r.organizationName)).toEqual([
      "Northwind",
      "Rheinfracht",
      "Deutsche Post",
    ]);
    expect(history[0]).toEqual({
      title: "Head of Operations",
      organizationName: "Northwind",
      startDate: "2021-04-01",
      endDate: null,
      description: "Runs the ops org.",
      current: true,
    });
    expect(history[1].current).toBe(false);
    expect(history[1].endDate).toBe("2021-03-31");
    // The history is NOT just the current employer restated.
    expect(history.filter((r) => r.current === true)).toHaveLength(1);
  });

  it("a provider serving none of it still yields a valid person, fields null", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ people: [BARE_APOLLO_PERSON], done: true, totalEntries: 1 })
    );
    const res = await peopleSearch({
      provider: "apollo",
      filters: { titles: ["Owner"] },
      identity,
    });
    const person = res.people[0];

    // Still a valid person on every field consumers already read.
    expect(person.email).toBe("otto@bare.example");
    expect(person.firstName).toBe("Otto");
    expect(person.organization?.name).toBe("Bare GmbH");

    // Absent stays absent — no defaults, no empty-list claim, no synthesis.
    expect(person.employmentHistory).toBeNull();
    const org = person.organization!;
    expect(org.shortDescription).toBeNull();
    expect(org.keywords).toBeNull();
    expect(org.technologyNames).toBeNull();
    expect(org.currentTechnologies).toBeNull();
    expect(org.industries).toBeNull();
    expect(org.fundingEvents).toBeNull();
    expect(org.latestFundingStage).toBeNull();
    expect(org.foundedYear).toBeNull();
    expect(org.primaryPhone).toBeNull();
    expect(org.rawAddress).toBeNull();
    expect(org.providerOrganizationId).toBeNull();
  });
});

describe("organization facts + career history — apollo reveal", () => {
  it("the revealed person carries them too (the serve-next path)", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ enrichmentId: "e-1", person: RICH_APOLLO_PERSON, cached: false })
    );
    const res = await resolveEmail({
      provider: "apollo",
      providerPersonId: "apollo-rich-1",
      identity,
    });
    const person = res.person!;

    expect(person.email).toBe("mira@northwind.io");
    expect(person.organization?.keywords).toEqual([
      "freight",
      "logistics",
      "supply chain",
    ]);
    expect(person.organization?.shortDescription).toBe(
      "Freight orchestration for mid-market shippers."
    );
    expect(person.organization?.latestFundingStage).toBe("Series B");
    expect(person.employmentHistory?.map((r) => r.title)).toEqual([
      "Head of Operations",
      "Operations Manager",
      "Analyst",
    ]);
  });
});

describe("organization facts + career history — apify", () => {
  it("apify serves none of it: the fields are null, the person stays valid", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({
        leads: [
          {
            firstName: "Ana",
            lastName: "Ruiz",
            fullName: "Ana Ruiz",
            title: "Owner",
            seniority: "owner",
            email: "ana@tienda.example",
            emailStatus: "verified",
            source: "pipelinelabs",
            isCatchAll: false,
            isInferred: false,
            linkedinUrl: null,
            city: "Madrid",
            state: null,
            country: "Spain",
            companyName: "Tienda Ruiz",
            companyDomain: "tienda.example",
            companyIndustry: "retail",
            companySize: 4,
            companyLinkedinUrl: null,
          },
        ],
        totalMatched: 1,
        hasMore: false,
        nextOffset: null,
      })
    );
    const res = await peopleSearch({
      provider: "apify",
      filters: { titles: ["Owner"] },
      identity,
    });
    const person = res.people[0];

    expect(person.email).toBe("ana@tienda.example");
    expect(person.organization?.name).toBe("Tienda Ruiz");
    expect(person.employmentHistory).toBeNull();
    expect(person.organization?.keywords).toBeNull();
    expect(person.organization?.technologyNames).toBeNull();
    expect(person.organization?.fundingEvents).toBeNull();
    expect(person.organization?.foundedYear).toBeNull();
  });
});
