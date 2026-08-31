import { describe, it, expect } from "vitest";
import { buildLayer1SystemPrompt } from "../../src/services/audiences.js";

/**
 * Layer 1 turns one natural-language request into ONE audience. It does not
 * split: the user validates the single audience in onboarding (they see the
 * resulting Apollo filters), and a later, separate step will split a validated
 * audience into sub-audiences for A/B testing
 * (shamanic-technologies/human-service#235).
 *
 * The split invariants (MECE partition, explicit-vs-unspecified axes, the
 * geography / revenue / headcount / funding ladders) are DEFERRED with their
 * prompt blocks — see the `SPLIT (deferred)` banners in src/services/audiences.ts.
 * Their assertions are deferred with them and must come back together.
 *
 * What stays asserted here are the rules that are load-bearing for ONE audience:
 * the client's product is never a targeting attribute, buying intent is not a
 * job title, one population per description, constraints stated positively, and
 * the two things this layer must not reason about (size, provider vocabulary).
 *
 * These assertions pin the prompt's invariants, not its prose. When rewording,
 * keep the invariant expressed somewhere in the prompt.
 */
describe("Layer 1 prompt", () => {
  const prompt = buildLayer1SystemPrompt();
  const lower = prompt.toLowerCase();

  it("asks for exactly ONE audience and carries no audience-count target", () => {
    expect(prompt).toContain("ONE target audience");
    expect(prompt).toContain("You do NOT split it");
    expect(prompt).toContain("EXACTLY ONE audience");
    // A numeric target in a prompt is the documented prime suspect for
    // fabrication (CLAUDE.md), and apollo-service's grader refuses filler.
    expect(lower).not.toContain("ballpark");
    expect(lower).not.toContain("6-8");
    expect(prompt).not.toMatch(/\b\d+\s*(-\s*\d+\s*)?audiences\b/);
  });

  it("restates the caller's audience without redefining WHO it is about", () => {
    expect(prompt).toContain("never");
    expect(prompt).toContain("redefine it");
    expect(prompt).toContain("you do not add people who should not be there");
    expect(prompt).toContain("you do not leave out people who should be there");
    expect(prompt).toContain("travels into your audience unchanged");
    expect(prompt).toContain("NOT yours to change");
    // A narrow request is a small audience, never a licence to widen WHO.
    expect(prompt).toContain("small is a correct answer");
    expect(prompt).toContain("reason to widen WHO");
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

  it("forbids the client's PRODUCT as a targeting attribute", () => {
    // Prod (#234): "Buyers and purchasing managers of psyllium husk products"
    // licensed a free-text keyword search for psyllium -> 0 matches -> the
    // builder dropped the product AND the geography. The targetable concept is
    // the shop type.
    expect(prompt).toContain("PRODUCT is NEVER a targeting attribute");
    expect(prompt).toContain("shop or company TYPE");
    // A trailing "...relevant for purchasing <product>" is still the product in
    // the sentence, and the builder reads the whole sentence as the spec.
    expect(prompt).toContain("Do not name the product");
    expect(prompt).toContain("not as trailing");
  });

  it("forbids rendering a buying INTENT as a procurement job title", () => {
    // A Swiss drogerie has 2-5 employees: there is no purchasing manager, the
    // owner buys. Measured in Apollo: procurement titles = 52 people country-wide
    // vs 1,919 with decision-maker seniority.
    expect(prompt).toContain("BUYING INTENT IS NOT A JOB TITLE");
    expect(prompt).toContain("unless the CALLER named those roles");
    expect(lower).toContain('"purchasing manager"');
    expect(lower).toContain('"purchasing staff"');
  });

  it("requires every constraint to be stated positively", () => {
    // Apollo has no person-location exclusion, so "German-speaking Switzerland
    // outside of Zurich" is inexpressible and the builder resolved it by
    // deleting the geography. The rule is about FORM, not provider vocabulary.
    expect(prompt).toContain("EVERY CONSTRAINT IS STATED POSITIVELY");
    expect(prompt).toContain('never "outside X"');
    expect(prompt).toContain('never "other than Y"');
    expect(prompt).toContain("list ALL of them by name");
    // A caller-stated SECTOR exclusion is a caller constraint and still travels.
    expect(prompt).toContain("a caller constraint and you carry it verbatim");
  });
});
