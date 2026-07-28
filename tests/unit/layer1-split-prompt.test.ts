import { describe, it, expect } from "vitest";
import { buildLayer1SystemPrompt } from "../../src/services/audiences.js";

/**
 * Layer 1 turns one natural-language request into a SET of audiences. It is a
 * PARTITION, so every audience it emits must be a subset of what the caller
 * asked for, and the union must cover the request.
 *
 * Regression source (2026-07-28, prod): the request was literally
 * "Chiropractors in the United States" and Layer 1 emitted, among 12 audiences,
 * one whose description read "Chief Medical Officers, Directors of Chiropractic,
 * and Senior Physicians in enterprise-level healthcare networks with 201+
 * employees". The employee-size partition produced a band that chiropractors
 * barely occupy, and instead of accepting a small audience the model rewrote WHO
 * the audience was about until the band was populated. apollo-service then built
 * that description faithfully, so the drift was invisible downstream.
 *
 * Two sibling drifts from the same run: "Chiropractors and Practice Owners ..."
 * and "Chiropractors and Managing Partners ..." — a role list reads as a UNION
 * of populations, so a bare "Practice Owner" matched dentists, vets and
 * accountants who own a practice.
 *
 * These assertions pin the prompt's invariants, not its prose. When rewording,
 * keep the invariant expressed somewhere in the prompt.
 */
describe("Layer 1 split prompt", () => {
  const prompt = buildLayer1SystemPrompt();
  const lower = prompt.toLowerCase();

  it("states the MECE invariant against the REQUESTED audience, not merely the axis", () => {
    // Subset + coverage, both directions, expressed against the request itself.
    expect(prompt).toContain("SUBSET of the request");
    expect(prompt).toContain("COVER the request");
    expect(prompt).toContain("you do not add people who should not be there");
    expect(prompt).toContain("you do not leave out people who should be there");

    // The old wording scoped MECE to the axis ("covers the whole space"), which a
    // 201+ employee band satisfies while holding zero of the requested people.
    expect(lower).not.toContain("covers the whole space");
    expect(prompt).toContain("MECE with respect to");
    expect(prompt).toContain("REQUESTED audience");
  });

  it("carries the caller's persona into every audience unchanged", () => {
    expect(prompt).toContain("never redefining it");
    expect(prompt).toContain("travels into every single audience unchanged");
    // Persona is a partition lever ONLY when the caller named several roles.
    expect(prompt).toContain("NOT yours to change");
    expect(prompt).toContain("only");
    expect(prompt).toContain("when the caller themselves named several roles");
    // The concrete regression: a sparse band must not be repopulated with other people.
    expect(prompt).toContain("that happens to fill a bucket");
  });

  it("accepts a small audience instead of widening WHO", () => {
    expect(prompt).toContain("small is a correct answer");
    expect(prompt).toContain("reason to widen WHO");
    // The count target is reached by subdividing further, never by widening.
    expect(prompt).toContain("subdividing an axis further");
    expect(prompt).toContain("NEVER by widening WHO");
  });

  it("requires ONE unambiguous population per description and binds generic roles", () => {
    expect(prompt).toContain("describes ONE population, never a union of several");
    expect(prompt).toContain("A generic word means nothing on its own");
    // Each generic title observed drifting in prod is named.
    for (const generic of ["owner", "founder", "director", "manager", "partner", "administrator"]) {
      expect(lower).toContain(`"${generic}"`);
    }
    expect(prompt).toContain("Bind every one of them");
  });

  it("declares audience SIZE out of scope for this layer", () => {
    expect(prompt).toContain("HOW MANY PEOPLE an audience holds");
    expect(prompt).toContain("never estimate, compare or worry");
    expect(prompt).toContain("a downstream expert measures that");
  });

  it("declares the provider filter vocabulary out of scope for this layer", () => {
    expect(prompt).toContain("filter vocabulary, field names or accepted values");
    expect(prompt).toContain("You write English");

    // No provider field name may leak into this layer's prompt.
    for (const apolloField of [
      "person_titles",
      "person_locations",
      "person_seniorities",
      "organization_industries",
      "organization_num_employees_ranges",
      "q_organization_keyword_tags",
      "q_keywords",
      "include_similar_titles",
      "revenue_range",
      "contact_email_status",
    ]) {
      expect(lower).not.toContain(apolloField);
    }
  });

  it("keeps the pre-existing split behaviour: rich set target + explicit-axis combinations", () => {
    // Kevin kept the 6-8 order of magnitude deliberately: it is reachable MECE-ly
    // (geography always subdivides one notch further), so it is not the defect.
    expect(prompt).toContain("ballpark 6-8");
    expect(prompt).toContain("MORE is fine");
    // Assertions also relied on by tests/integration/audiences-suggest.test.ts —
    // each must stay on ONE array line so `.includes` still matches after join.
    expect(prompt).toContain("decompose a natural-language audience");
    expect(prompt).toContain("When multiple independent axes are explicitly present");
    expect(prompt).toMatch(/Example: 3 personas\s+x 2 company types = 6 audiences/);
    // The default firmographic partition axes stay available.
    for (const axis of ["GEOGRAPHY", "REVENUE", "EMPLOYEE SIZE", "FUNDING STAGE"]) {
      expect(prompt).toContain(axis);
    }
  });
});
