import { describe, it, expect } from "vitest";
import {
  buildChooserSystemPrompt,
  buildChooserMessage,
  buildChooserTrace,
  CHOOSER_TRACE_VERSION,
} from "../../src/services/audience-chooser.js";
import type { ApolloCandidate } from "../../src/lib/apollo-audiences.js";

// These pin the INVARIANTS of the chooser prompt, not its prose. They exist
// because every apollo-side selection mechanism degenerated the same way, and
// the properties below are what make this one different: it is COMPARATIVE, it
// decides on WHO is in the set, it carries the volume context WITHOUT turning it
// into a floor, and it always returns one.
describe("chooser system prompt", () => {
  const prompt = buildChooserSystemPrompt();

  it("asks for ONE pick out of the attempts — comparative, never a per-attempt grade", () => {
    expect(prompt).toContain("YOU PICK EXACTLY ONE");
    expect(prompt).toContain("Compare the attempts against each other");
    // No absolute self-grade question ("is this one good?") — that is the shape
    // that came back true on 60 of 60 rounds.
    expect(prompt).not.toMatch(/is this (one|attempt) good/i);
  });

  it("never lets it refuse to pick", () => {
    expect(prompt).toContain("You always pick one");
    expect(prompt).toContain("no option to refuse");
  });

  it("makes the SAMPLE the deciding evidence, above the count", () => {
    expect(prompt).toContain("WHO IS IN THE SET");
    expect(prompt).toContain("Read the sample rows before anything else");
    expect(prompt).toContain(
      "a count tells you how many people a set holds, never whether they are the client's people"
    );
  });

  it("carries the cold-email volume context", () => {
    expect(prompt).toContain("COLD EMAIL");
    expect(prompt).toContain("somewhat-");
    expect(prompt).toContain("2,000 contactable people");
    expect(prompt).toContain("50,000");
  });

  it("states, in the same breath, that those numbers are NOT a floor", () => {
    expect(prompt).toContain("THEY ARE NOT A FLOOR TO REACH");
    expect(prompt).toContain("A GENUINELY SMALL");
    expect(prompt).toContain("MARKET IS A VALID, CORRECT ANSWER");
  });

  it("asks the chooser itself for the name and the description of what it picked", () => {
    expect(prompt).toContain("MAX 4 words");
    expect(prompt).toContain("ONE self-contained present-tense sentence");
    expect(prompt).toContain("never promise a constraint the chosen set does not encode");
  });

  it("defines degraded as a verdict that never withholds an audience", () => {
    expect(prompt).toContain("it never means you return nothing");
  });

  it("imposes no count floor, target band or ranking rule", () => {
    expect(prompt).not.toMatch(/at least \d/i);
    expect(prompt).not.toMatch(/minimum of \d/i);
    expect(prompt).not.toMatch(/pick the largest/i);
    expect(prompt).not.toMatch(/highest count/i);
    expect(prompt).not.toMatch(/score/i);
  });
});

describe("chooser message", () => {
  const candidates: ApolloCandidate[] = [
    {
      apolloAudienceId: "a1",
      filters: { qOrganizationKeywordTags: ["retail"] },
      count: 179156,
      sample: [{ company: "Mars", title: "Procurement Manager" }],
      notes: {
        whatWorked: "broad tags returned volume",
        whatToImprove: "multinationals, not shops",
        nextExperiment: "tighten the tags",
      },
    },
    {
      apolloAudienceId: "a2",
      filters: { qOrganizationKeywordTags: ["drogerie"] },
      count: 659,
      sample: [{ company: "Abderhalden Drogerie AG", title: null }],
      notes: null,
    },
  ];

  it("renders EVERY candidate with its count, sample and notes", () => {
    const msg = buildChooserMessage({ nlPrompt: "swiss drugstores", candidates });
    expect(msg).toContain("swiss drugstores");
    expect(msg).toContain("THE 2 ATTEMPTS");
    expect(msg).toContain("ATTEMPT 1");
    expect(msg).toContain("ATTEMPT 2");
    expect(msg).toContain("179156");
    expect(msg).toContain("659");
    expect(msg).toContain("Mars — Procurement Manager");
    expect(msg).toContain("Abderhalden Drogerie AG — unknown title");
    expect(msg).toContain("broad tags returned volume");
    expect(msg).toContain("qOrganizationKeywordTags");
  });

  it("says plainly when an attempt carries no sample, rather than inventing rows", () => {
    const msg = buildChooserMessage({
      nlPrompt: "x",
      candidates: [
        { apolloAudienceId: "a", filters: {}, count: 1, sample: [], notes: null },
      ],
    });
    expect(msg).toContain("none supplied for this attempt");
  });
});

// #245 — the reasoning is persisted, and the rejections must be justified.
describe("chooser prompt: accounting for every attempt", () => {
  const prompt = buildChooserSystemPrompt();

  it("asks for a sentence on the attempts it did NOT take", () => {
    expect(prompt).toContain("ACCOUNT FOR EVERY ATTEMPT");
    expect(prompt).toContain("including the ones you did not take");
    expect(prompt).toContain("what made you pass over it");
  });

  it("orders the justification AFTER the pick, never a per-attempt grade first", () => {
    expect(prompt).toContain("Do this AFTER you have");
    expect(prompt).toContain("never before");
    const pickAt = prompt.indexOf("YOU PICK EXACTLY ONE");
    const accountAt = prompt.indexOf("ACCOUNT FOR EVERY ATTEMPT");
    expect(pickAt).toBeGreaterThanOrEqual(0);
    expect(accountAt).toBeGreaterThan(pickAt);
  });

  it("shows the cost of a constraint as INFORMATION, never as a rule about fields", () => {
    expect(prompt).toContain("WHAT EACH ATTEMPT COST IN VOLUME");
    expect(prompt).toContain("This is INFORMATION, not a rule");
    expect(prompt).toContain("no field is");
    expect(prompt).toContain("more fields is neither better nor worse");
    // No field is ever named as good or bad.
    expect(prompt).not.toMatch(/organization_industries|organizationIndustries/i);
    expect(prompt).not.toMatch(/employee (cap|range)/i);
  });
});

describe("chooser message: the volume cost of a constraint", () => {
  const candidates: ApolloCandidate[] = [
    {
      apolloAudienceId: "wide",
      filters: { personLocations: ["Switzerland"] },
      count: 2078,
      sample: [{ company: "Drogerie Meer", title: "Inhaber" }],
      notes: null,
    },
    {
      apolloAudienceId: "narrow",
      filters: {
        personLocations: ["Switzerland"],
        organizationIndustries: ["retail"],
        organizationNumEmployeesRanges: ["1,10"],
        emptyOne: [],
      },
      count: 115,
      sample: [{ company: "Bio Partner Schweiz", title: "CEO" }],
      notes: null,
    },
  ];
  const msg = buildChooserMessage({ nlPrompt: "swiss drugstores", candidates });

  it("puts every attempt's volume next to the fields that produced it, on adjacent rows", () => {
    expect(msg).toContain("AT A GLANCE");
    expect(msg).toContain("  1 | 2078 | 1: personLocations");
    expect(msg).toContain(
      "  2 | 115 | 3: personLocations, organizationIndustries, organizationNumEmployeesRanges"
    );
  });

  it("repeats the fields on each attempt block, and ignores empty ones", () => {
    expect(msg).toContain("filter fields used (1): personLocations");
    // An empty-valued key constrains nothing, so it is not counted as a field —
    // though the raw filter object is still echoed verbatim below the list.
    expect(msg).not.toContain("emptyOne, ");
    expect(msg).toContain("filter fields used (3): personLocations,");
    expect(msg).toContain('"emptyOne":[]');
  });

  it("keeps the exploration order and ranks nothing", () => {
    expect(msg.indexOf("ATTEMPT 1")).toBeLessThan(msg.indexOf("ATTEMPT 2"));
    expect(msg).not.toMatch(/best|worst|rank|score/i);
  });
});

describe("buildChooserTrace", () => {
  const candidates: ApolloCandidate[] = [
    {
      apolloAudienceId: "wide",
      filters: { personLocations: ["Switzerland"] },
      count: 2078,
      sample: Array.from({ length: 10 }, (_, i) => ({
        company: `Co ${i}`,
        title: "Inhaber",
      })),
      notes: null,
    },
    {
      apolloAudienceId: "narrow",
      filters: { personLocations: ["Switzerland"], organizationIndustries: ["retail"] },
      count: 115,
      sample: [{ company: "Bio Partner Schweiz", title: "CEO" }],
      notes: null,
    },
  ];

  const trace = buildChooserTrace({
    nlPrompt: "swiss drugstores",
    candidates,
    chosen: {
      candidate: candidates[1],
      chosen: 2,
      why: "its sample is recognisably the target",
      rationales: ["reaches too many manufacturers", "the one I took"],
      name: "Swiss Drogerien",
      description: "owners of independent Swiss drugstores",
      degraded: true,
      degradedReason: "nothing enumerated the cantons",
    },
  });

  it("records the overall verdict, degraded and its reason", () => {
    expect(trace.version).toBe(CHOOSER_TRACE_VERSION);
    expect(trace.chosen).toBe(2);
    expect(trace.why).toBe("its sample is recognisably the target");
    expect(trace.degraded).toBe(true);
    expect(trace.degradedReason).toBe("nothing enumerated the cantons");
  });

  it("records EVERY candidate with count, filters, fields, sample, chosen flag and rationale", () => {
    const rows = trace.candidates as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      attempt: 1,
      apolloAudienceId: "wide",
      count: 2078,
      filterFields: ["personLocations"],
      chosen: false,
      rationale: "reaches too many manufacturers",
    });
    expect(rows[1]).toMatchObject({ attempt: 2, chosen: true, rationale: "the one I took" });
    expect(rows[1].filters).toEqual(candidates[1].filters);
  });

  it("reduces the sample rather than storing all ten", () => {
    const rows = trace.candidates as Array<{ sample: unknown[] }>;
    expect(rows[0].sample).toHaveLength(5);
    expect(rows[1].sample).toHaveLength(1);
  });

  it("records an absent degraded reason as null, never as an empty sentence", () => {
    const t = buildChooserTrace({
      nlPrompt: "x",
      candidates: [candidates[0]],
      chosen: {
        candidate: candidates[0],
        chosen: 1,
        why: "w",
        rationales: ["r"],
        name: "n",
        description: "d",
        degraded: false,
        degradedReason: "",
      },
    });
    expect(t.degradedReason).toBeNull();
  });
});
