import { describe, it, expect } from "vitest";
import {
  buildEstimateSystemPrompt,
  roundApproximate,
  sanitizeDraftFilters,
} from "../../src/services/audience-split-estimate.js";

describe("split estimate helpers", () => {
  it("rounds to 2 significant figures", () => {
    expect(roundApproximate(0)).toBe(0);
    expect(roundApproximate(7)).toBe(7);
    expect(roundApproximate(87)).toBe(87);
    expect(roundApproximate(987)).toBe(990);
    expect(roundApproximate(41234)).toBe(41000);
    expect(roundApproximate(1_560_000)).toBe(1_600_000);
  });

  it("forces exact titles and strips buying signals", () => {
    expect(sanitizeDraftFilters({ person_titles: ["CEO"], include_similar_titles: true, buying_signal: {} })).toEqual({
      person_titles: ["CEO"],
      include_similar_titles: false,
    });
    expect(sanitizeDraftFilters({ person_seniorities: ["owner"], include_similar_titles: true })).toEqual({
      person_seniorities: ["owner"],
    });
  });

  it("embeds apollo's filter reference and asks for one entry per segment", () => {
    const p = buildEstimateSystemPrompt("REFERENCE-BLOCK");
    expect(p).toContain("REFERENCE-BLOCK");
    expect(p).toContain('{"segments":[{"index":');
    expect(p).toContain("Never use buying_signal.");
  });
});
