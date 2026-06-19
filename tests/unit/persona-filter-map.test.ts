import { describe, it, expect } from "vitest";
import {
  mapPersonaFiltersToCanonical,
  hasPersonaVocab,
  isPersonaVocabKey,
  PersonaFilterMapError,
} from "../../src/services/persona-filter-map.js";
import { PeopleSearchFiltersSchema } from "../../src/schemas.js";

describe("mapPersonaFiltersToCanonical — verbatim key renames", () => {
  it("renames industry/jobTitles/keywords/technologies/fundingStage/revenueRange, values verbatim", () => {
    const out = mapPersonaFiltersToCanonical({
      industry: ["SaaS", "Fintech"],
      jobTitles: ["CEO", "Founder"],
      keywords: ["growth"],
      technologies: ["React"],
      fundingStage: ["Series A"],
      revenueRange: [">$1M"],
    });
    expect(out).toEqual({
      industries: ["SaaS", "Fintech"],
      titles: ["CEO", "Founder"],
      keywords: ["growth"],
      technologies: ["React"],
      fundingStages: ["Series A"],
      revenueRanges: [">$1M"],
    });
  });
});

describe("mapPersonaFiltersToCanonical — seniority enum filtering", () => {
  it("lowercases, keeps only enum values, drops the rest", () => {
    const out = mapPersonaFiltersToCanonical({
      seniority: ["Manager", "c_suite", "director", "Intern", "lead"],
    });
    expect(out).toEqual({ seniorities: ["manager", "c_suite", "director"] });
  });

  it("omits seniorities entirely when every value is dropped", () => {
    const out = mapPersonaFiltersToCanonical({ seniority: ["Intern", "lead"] });
    expect(out).toEqual({});
  });
});

describe("mapPersonaFiltersToCanonical — department -> functions", () => {
  it("lowercases, replaces spaces with underscores, dedupes", () => {
    const out = mapPersonaFiltersToCanonical({
      department: ["human resources", "human_resources", "Sales"],
    });
    expect(out).toEqual({ functions: ["human_resources", "sales"] });
  });
});

describe("mapPersonaFiltersToCanonical — location -> locationCountries (no split)", () => {
  it("maps all location values to countries verbatim, no city/state split", () => {
    const out = mapPersonaFiltersToCanonical({
      location: ["France", "Paris", "Paris, France"],
    });
    expect(out).toEqual({
      locationCountries: ["France", "Paris", "Paris, France"],
    });
  });
});

describe("mapPersonaFiltersToCanonical — employeeRange parsing", () => {
  it("parses contiguous buckets to min-of-lows / max-of-highs", () => {
    const out = mapPersonaFiltersToCanonical({
      employeeRange: ["11-50", "51-200"],
    });
    expect(out).toEqual({ employeeMin: 11, employeeMax: 200 });
  });

  it("treats an open-ended bucket as unbounded max (omits employeeMax)", () => {
    const out = mapPersonaFiltersToCanonical({
      employeeRange: ["501-1000", "10001+"],
    });
    expect(out).toEqual({ employeeMin: 501 });
  });

  it("handles a single bucket", () => {
    const out = mapPersonaFiltersToCanonical({ employeeRange: ["1-10"] });
    expect(out).toEqual({ employeeMin: 1, employeeMax: 10 });
  });

  it("is lossy on non-contiguous buckets (gap included)", () => {
    const out = mapPersonaFiltersToCanonical({
      employeeRange: ["1-10", "1001-5000"],
    });
    expect(out).toEqual({ employeeMin: 1, employeeMax: 5000 });
  });

  it("throws on an unparseable bucket", () => {
    expect(() =>
      mapPersonaFiltersToCanonical({ employeeRange: ["foo"] })
    ).toThrow(PersonaFilterMapError);
  });
});

describe("mapPersonaFiltersToCanonical — fail loud", () => {
  it("throws on an unknown persona key (no canonical target)", () => {
    expect(() => mapPersonaFiltersToCanonical({ mysteryKey: ["x"] })).toThrow(
      PersonaFilterMapError
    );
  });

  it("throws on a wrong-typed persona value", () => {
    expect(() =>
      mapPersonaFiltersToCanonical({ industry: "not-an-array" })
    ).toThrow(PersonaFilterMapError);
  });
});

describe("mapPersonaFiltersToCanonical — idempotency", () => {
  it("passes an already-canonical blob through unchanged", () => {
    const canonical = {
      titles: ["CEO"],
      seniorities: ["c_suite"],
      locationCountries: ["France"],
      employeeMin: 11,
      employeeMax: 200,
    };
    expect(mapPersonaFiltersToCanonical(canonical)).toEqual(canonical);
  });

  it("re-mapping a mapped result is a no-op", () => {
    const once = mapPersonaFiltersToCanonical({
      industry: ["SaaS"],
      seniority: ["Manager"],
      employeeRange: ["11-50"],
    });
    expect(mapPersonaFiltersToCanonical(once)).toEqual(once);
  });

  it("handles null/undefined/empty input", () => {
    expect(mapPersonaFiltersToCanonical(null)).toEqual({});
    expect(mapPersonaFiltersToCanonical(undefined)).toEqual({});
    expect(mapPersonaFiltersToCanonical({})).toEqual({});
  });
});

describe("mapPersonaFiltersToCanonical — round-trips through audiences Zod", () => {
  it("output parses through PeopleSearchFiltersSchema with zero stripping", () => {
    const out = mapPersonaFiltersToCanonical({
      industry: ["SaaS"],
      jobTitles: ["CEO"],
      seniority: ["Manager", "Intern"],
      department: ["sales"],
      location: ["France"],
      employeeRange: ["11-50"],
      keywords: ["growth"],
    });
    const parsed = PeopleSearchFiltersSchema.parse(out);
    expect(parsed).toEqual(out);
    // No persona-vocab key survives.
    for (const k of Object.keys(out)) {
      expect(isPersonaVocabKey(k)).toBe(false);
    }
  });
});

describe("hasPersonaVocab / isPersonaVocabKey", () => {
  it("detects persona-vocab presence", () => {
    expect(hasPersonaVocab({ industry: ["x"] })).toBe(true);
    expect(hasPersonaVocab({ industries: ["x"] })).toBe(false);
    expect(hasPersonaVocab({})).toBe(false);
    expect(hasPersonaVocab(null)).toBe(false);
  });

  it("classifies keys", () => {
    expect(isPersonaVocabKey("jobTitles")).toBe(true);
    expect(isPersonaVocabKey("titles")).toBe(false);
  });
});
