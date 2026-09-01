import { describe, it, expect } from "vitest";
import {
  buildChooserSystemPrompt,
  buildChooserMessage,
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
