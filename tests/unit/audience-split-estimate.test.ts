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

  it("keeps facts Apollo rarely holds out of the filters, generically (TINY-SPLIT-AUDIENCES-1126)", () => {
    const p = buildEstimateSystemPrompt("REF");
    expect(p).toContain("Filter ONLY on facts Apollo holds for nearly every person and company");
    expect(p).toContain("tools or technologies a company");
    expect(p).toContain("its revenue, its funding");
    expect(p).toContain("it stays in the audience text");
    // A principle, never a rule keyed on one tool or one client.
    expect(p).not.toMatch(/zapier|n8n|writebros|agenc|content director|content marketing/i);
    // It replaces the old revenue/funding rule, never sits beside it.
    expect(p).not.toContain("Never use revenue_range or funding fields");
  });

});
