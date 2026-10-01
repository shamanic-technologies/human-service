import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The provider's verdict on a revealed email (apollo-service emailVerification)
// is its own suite's concern; here every revealed address reads as deliverable.
vi.mock("../../src/lib/email-verification.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readEmailVerification: (_p: string, _r: unknown, email: string | null | undefined) =>
    email ? { verdict: "valid", deliverable: true } : null,
}));
import {
  peopleSearch,
  resolveEmail,
} from "../../src/services/people-providers.js";

// The serve path reads the org's consent log from instantly-service on every
// serve. That gate has its own suite (opt-outs.test.ts / audiences-opt-out.test.ts);
// here it is stubbed to an empty log so these tests stay about their own subject.
// Same for the brand's won people (lead-service) — stubbed to an empty set.
vi.mock("../../src/lib/lead-won.js", () => ({
  listWonEmails: vi.fn(async () => []),
  isEmailWon: vi.fn(async () => false),
  WonLeadsSourceError: class WonLeadsSourceError extends Error {},
  WonLeadsConfigError: class WonLeadsConfigError extends Error {},
}));
vi.mock("../../src/lib/instantly-optouts.js", () => ({
  listStandingOptOutEmails: vi.fn(async () => []),
  isEmailOptedOut: vi.fn(async () => false),
  OptOutSourceError: class OptOutSourceError extends Error {},
  OptOutConfigError: class OptOutConfigError extends Error {},
}));


// (fixtures shared with people-organization-facts.test.ts)
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A person revealed from a buying-signal audience must reach the serve path
// carrying the signal apollo-service returned beside it, verbatim; a person
// without one carries null, never a default.
const SIGNAL = {
  type: "hiring",
  occurredOn: "2026-09-21",
  fact: "Northwind posted a job for Office Manager (Berlin, Germany) on September 21, 2026",
  source: "apollo:job_postings",
  sourceUrl: "https://jobs.example/northwind/office-manager",
};

describe("buying signal — apollo reveal", () => {
  it("carries the reveal's buyingSignal onto the neutral person", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ person: RICH_APOLLO_PERSON, buyingSignal: SIGNAL, emailVerification: {} })
    );
    const res = await resolveEmail({ providerPersonId: "apollo-rich-1", identity });
    expect(res.person?.buyingSignal).toEqual(SIGNAL);
  });

  it("normalises an absent sourceUrl to null", async () => {
    const { sourceUrl: _drop, ...noUrl } = SIGNAL;
    fetchSpy.mockResolvedValueOnce(
      ok({ person: RICH_APOLLO_PERSON, buyingSignal: noUrl, emailVerification: {} })
    );
    const res = await resolveEmail({ providerPersonId: "apollo-rich-1", identity });
    expect(res.person?.buyingSignal).toEqual({ ...noUrl, sourceUrl: null });
  });

  it("is null when the reveal carries none (null or absent)", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ person: BARE_APOLLO_PERSON, buyingSignal: null, emailVerification: {} })
    );
    const a = await resolveEmail({ providerPersonId: "apollo-bare-1", identity });
    expect(a.person?.buyingSignal).toBeNull();
    fetchSpy.mockResolvedValueOnce(ok({ person: BARE_APOLLO_PERSON, emailVerification: {} }));
    const b = await resolveEmail({ providerPersonId: "apollo-bare-1", identity });
    expect(b.person?.buyingSignal).toBeNull();
  });

  it("fails loud on a malformed signal rather than serving half a claim", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ person: RICH_APOLLO_PERSON, buyingSignal: { type: "hiring" }, emailVerification: {} })
    );
    await expect(
      resolveEmail({ providerPersonId: "apollo-rich-1", identity })
    ).rejects.toThrow(/malformed buyingSignal/);
  });

  it("a free search teaser carries no signal", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ people: [RICH_APOLLO_PERSON], done: true, totalEntries: 1 })
    );
    const res = await peopleSearch({ provider: "apollo", filters: {}, identity });
    expect(res.people[0].buyingSignal).toBeNull();
  });
});
