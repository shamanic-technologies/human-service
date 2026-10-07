import { describe, it, expect } from "vitest";

// What stays of the pre-pay screen after it moved to lead-service (2026-10-07):
// the teaser snapshot handed to the caller, the historical bar the staff
// snapshot reads, and the yield stop rule the candidate path applies.
import {
  isScreenYieldSpent,
  SCREEN_YIELD_MIN_PASSES,
  SCREEN_YIELD_WINDOW,
  toTeaserSnapshot,
  SCREEN_MIN_YES_PROBABILITY,
} from "../../src/services/teaser-screening.js";
import type { Person } from "../../src/services/people-providers.js";

function person(overrides: Partial<Person> = {}): Person {
  return {
    firstName: "C",
    lastName: null,
    name: null,
    title: "Chiropractor",
    headline: null,
    seniority: "owner",
    email: null,
    emailStatus: null,
    catchAll: null,
    inferred: null,
    linkedinUrl: "https://linkedin.com/in/c",
    photoUrl: null,
    city: "Zurich",
    state: "ZH",
    country: "Switzerland",
    timezone: null,
    businessLanguages: [],
    provider: "apollo",
    providerPersonId: "p1",
    organization: null,
    employmentHistory: null,
    buyingSignal: null,
    ...overrides,
  } as Person;
}

describe("historical acceptance bar", () => {
  it("is ABOVE 0.50 (the bar every v2 bronze verdict since 2026-09-29 was taken under)", () => {
    expect(SCREEN_MIN_YES_PROBABILITY).toBe(0.5);
  });
});

describe("toTeaserSnapshot", () => {
  it("carries the judgeable fields verbatim and keeps absences absent", () => {
    const snap = toTeaserSnapshot(person());
    expect(snap.title).toBe("Chiropractor");
    expect(snap.seniority).toBe("owner");
    expect(snap.country).toBe("Switzerland");
    // No organization on the teaser ⟹ null, not an empty object or a guess.
    expect(snap.organizationName).toBeNull();
    expect(snap.organizationKeywords).toBeNull();
    // Apollo masks the last name on a free teaser; the first name is what there is.
    expect(snap.name).toBe("C");
  });

  it("caps organization keywords — an unbounded tail buys no signal", () => {
    const keywords = Array.from({ length: 50 }, (_, i) => `k${i}`);
    const snap = toTeaserSnapshot(
      person({
        organization: {
          name: "Acme",
          domain: null,
          websiteUrl: null,
          industry: "health",
          estimatedNumEmployees: 3,
          annualRevenue: null,
          linkedinUrl: null,
          logoUrl: null,
          city: null,
          state: null,
          country: null,
          keywords,
        } as unknown as Person["organization"],
      })
    );
    expect(snap.organizationKeywords).toHaveLength(20);
    expect(snap.organizationKeywords?.[0]).toBe("k0");
    expect(snap.organizationName).toBe("Acme");
    expect(snap.organizationEmployees).toBe(3);
  });
});

describe("screen yield stop rule", () => {
  it("is 1,000 verdicts, fewer than 3 passes", () => {
    expect(SCREEN_YIELD_WINDOW).toBe(1000);
    expect(SCREEN_YIELD_MIN_PASSES).toBe(3);
  });

  it("trips the dead tail: Shockwavecenters' chiropractors, 2 passes in their last 1,000 screens", () => {
    expect(isScreenYieldSpent({ screens: 1000, passes: 2 })).toBe(true);
    expect(isScreenYieldSpent({ screens: 1000, passes: 0 })).toBe(true);
  });

  it("never trips a selective but productive audience (1-2% passes, ~12 per 1,000)", () => {
    expect(isScreenYieldSpent({ screens: 1000, passes: 12 })).toBe(false);
    expect(isScreenYieldSpent({ screens: 1000, passes: 3 })).toBe(false);
  });

  it("never trips before a full window: a new audience is not judged on its first rejections", () => {
    expect(isScreenYieldSpent({ screens: 999, passes: 0 })).toBe(false);
    expect(isScreenYieldSpent({ screens: 0, passes: 0 })).toBe(false);
  });
});
