import { describe, it, expect } from "vitest";
import {
  buildSplitSystemPrompt,
  MAX_SPLIT_SEGMENTS,
  SPLIT_AXES,
  SPLIT_ICONS,
} from "../../src/services/audience-split.js";

/** Pins the split's invariants, not its prose. */
describe("audience split prompt", () => {
  const prompt = buildSplitSystemPrompt();
  const lower = prompt.toLowerCase();

  it("caps at 6 and allows a single segment", () => {
    expect(MAX_SPLIT_SEGMENTS).toBe(6);
    expect(prompt).toContain("AT MOST");
    expect(lower).toContain("one is a");
  });

  it("demands a MECE partition that never redefines WHO", () => {
    expect(lower).toContain("mutually exclusive");
    expect(lower).toContain("collectively exhaustive");
    expect(prompt).toContain("travels into EVERY segment unchanged");
  });

  it("splits only along filterable axes, one or two crossed, never mixed", () => {
    for (const axis of SPLIT_AXES) expect(prompt).toContain(`"${axis}"`);
    expect(prompt).toContain("Prefer ONE axis");
    expect(prompt).toContain("CROSSING");
    expect(prompt).toContain("Never mix axes");
  });

  it("states partition values positively and never targets the product", () => {
    expect(prompt).toContain("POSITIVELY");
    expect(lower).toContain("never name the customer's own product");
  });

  it("does not reason about size or provider vocabulary", () => {
    expect(lower).toContain("never estimate size");
    for (const field of ["person_titles", "organization_locations", "q_keywords"]) {
      expect(prompt).not.toContain(field);
    }
  });

  it("the icon vocabulary is closed kebab-case Phosphor names", () => {
    const tokens = Object.keys(SPLIT_ICONS);
    expect(tokens.length).toBeGreaterThanOrEqual(20);
    expect(tokens.length).toBeLessThanOrEqual(255);
    for (const t of tokens) expect(t).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});
