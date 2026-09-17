import { describe, it, expect } from "vitest";
import {
  buildScreenMessage,
  buildScreenSystemPrompt,
  toTeaserSnapshot,
  SCREEN_LLM_MODEL,
  SCREEN_LLM_PROVIDER,
} from "../../src/services/teaser-screening.js";
import type { Person } from "../../src/services/people-providers.js";

// These pin the INVARIANTS of the screen, not its prose. The screen decides
// whether an apollo credit is spent, so the two ways it can be wrong are
// asymmetric: a wrong pass costs one email, a wrong reject costs a prospect the
// client wanted and paid to find. The prompt has to say so.

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
    ...overrides,
  } as Person;
}

describe("screen system prompt", () => {
  const prompt = buildScreenSystemPrompt();

  it("judges ONE person, not a batch", () => {
    // A cheap model asked for N verdicts keyed on a list index drifts, and a
    // drifted verdict is worse than no screen.
    expect(prompt).toContain("ONE person");
  });

  it("treats a missing field as unknown, never as a reason to reject", () => {
    expect(prompt).toContain(
      "A field you cannot see is unknown, never a reason"
    );
    expect(prompt).toContain("reject only on something the record actually says");
  });

  it("resolves borderline cases as a pass, and says why", () => {
    expect(prompt).toContain("Borderline cases are a yes.");
    expect(prompt).toContain("wrongly-rejected one");
  });

  it("names what a rejection may be based on", () => {
    expect(prompt).toContain("the wrong occupation");
  });

  it("asks for the verdict and one sentence", () => {
    expect(prompt).toContain('{"onTarget": boolean, "why": one short sentence}');
  });
});

describe("screen message", () => {
  it("carries the audience's own name and description plus the candidate", () => {
    const msg = buildScreenMessage(
      { name: "Swiss Chiropractors", description: "chiropractors who own their practice in Switzerland" },
      toTeaserSnapshot(person())
    );
    expect(msg).toContain("Swiss Chiropractors");
    expect(msg).toContain("chiropractors who own their practice in Switzerland");
    expect(msg).toContain("Chiropractor");
    expect(msg).toContain("Zurich");
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

  it("caps organization keywords — an unbounded tail is paid for on every screen", () => {
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

describe("screen model", () => {
  it("runs on the cheapest model reachable through chat-service", () => {
    // GLM-5.3-Flash at $0.15/$0.50 per 1M tokens, against Gemini 3.5 Flash-Lite's
    // $0.30/$2.50. The screen is deliberately allowed to be the slow one.
    expect(SCREEN_LLM_PROVIDER).toBe("zai");
    expect(SCREEN_LLM_MODEL).toBe("glm-flash");
  });
});
