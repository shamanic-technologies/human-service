import { describe, it, expect, vi, beforeEach } from "vitest";

// The DB and chat-service are stubbed: these tests are about the DECISION the
// screen makes from Jev's answer, and about what it records.
const inserted: { table: unknown; values: Record<string, unknown> }[] = [];
vi.mock("../../src/db/index.js", () => {
  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table, values });
        return { onConflictDoNothing: async () => undefined };
      },
    }),
  };
  return { db: { transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) } };
});
const judgeYesNo = vi.fn();
vi.mock("../../src/lib/chat-client.js", () => ({
  judgeYesNo: (...a: unknown[]) => judgeYesNo(...a),
}));

import {
  buildScreenState,
  screenTeaser,
  toTeaserSnapshot,
  SCREEN_MIN_YES_PROBABILITY,
  SCREEN_PROMPT_VERSION,
  SCREEN_QUESTION,
} from "../../src/services/teaser-screening.js";
import { audienceScreenedOut, audienceTeaserScreenings } from "../../src/db/schema.js";
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
    ...overrides,
  } as Person;
}

const NL_PROMPT =
  "Everyone working in Swiss shops that sell natural health products: Drogerien, Reformhäuser, Bioläden.";
const identity = { orgId: "00000000-0000-4000-8000-000000000001" };

function screen(yesProbability: number | Error, nlPrompt: string | null = NL_PROMPT) {
  if (yesProbability instanceof Error) judgeYesNo.mockRejectedValueOnce(yesProbability);
  else judgeYesNo.mockResolvedValueOnce({ yesProbability, model: "jev-1.13.0" });
  return screenTeaser({
    orgId: identity.orgId,
    audience: { id: "aud-1", nlPrompt },
    subject: {
      providerPersonId: "p1",
      linkedinUrl: null,
      teaser: toTeaserSnapshot(person({ title: "Group CFO" })),
    },
    identity,
  });
}

describe("screenTeaser — Jev yes-probability against the customer's own words", () => {
  beforeEach(() => {
    inserted.length = 0;
    judgeYesNo.mockReset();
  });

  it("accepts only ABOVE 0.50", () => {
    expect(SCREEN_MIN_YES_PROBABILITY).toBe(0.5);
  });

  it("0.60 passes: bronze row only, no exclusion", async () => {
    const out = await screen(0.6);
    expect(out).toEqual({ screened: true, onTarget: true, yesProbability: 0.6 });
    expect(inserted.map((r) => r.table)).toEqual([audienceTeaserScreenings]);
    expect(inserted[0].values).toMatchObject({
      verdict: true,
      yesProbability: 0.6,
      model: "typesafe/jev-1.13.0",
      promptVersion: "v2",
    });
  });

  it("exactly 0.50 rejects, and lands in the silver exclusion set", async () => {
    const out = await screen(0.5);
    expect(out).toMatchObject({ screened: true, onTarget: false });
    expect(inserted.map((r) => r.table)).toEqual([
      audienceTeaserScreenings,
      audienceScreenedOut,
    ]);
    expect(inserted[0].values).toMatchObject({ verdict: false, yesProbability: 0.5 });
  });

  it("0.30 rejects", async () => {
    const out = await screen(0.3);
    expect(out).toMatchObject({ screened: true, onTarget: false, yesProbability: 0.3 });
    expect(inserted[1].table).toBe(audienceScreenedOut);
  });

  it("judges against nl_prompt verbatim, with ONE yes/no question", async () => {
    await screen(0.9);
    expect(judgeYesNo).toHaveBeenCalledTimes(1);
    const call = judgeYesNo.mock.calls[0][0] as {
      state: { targetAudience: string; candidate: { title: string } };
      instructions: string;
    };
    expect(call.state.targetAudience).toBe(NL_PROMPT);
    expect(call.state.candidate.title).toBe("Group CFO");
    expect(call.instructions).toBe(SCREEN_QUESTION);
  });

  it("no nl_prompt ⟹ skipped with a named reason, Jev never called, nothing written", async () => {
    for (const nl of [null, "   "]) {
      const out = await screenTeaser({
        orgId: identity.orgId,
        audience: { id: "aud-1", nlPrompt: nl },
        subject: { providerPersonId: "p1", linkedinUrl: null, teaser: toTeaserSnapshot(person()) },
        identity,
      });
      expect(out).toEqual({ screened: false, skipReason: "no_nl_prompt" });
    }
    expect(judgeYesNo).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it("a Jev error propagates — nothing recorded, no pass", async () => {
    await expect(screen(new Error("jev down"))).rejects.toThrow("jev down");
    expect(inserted).toEqual([]);
  });

  it("the question carries no 'borderline = yes' guidance", () => {
    expect(SCREEN_QUESTION.toLowerCase()).not.toContain("borderline");
    expect(SCREEN_PROMPT_VERSION).toBe("v2");
  });
});

describe("screen state", () => {
  it("carries the customer's words and the candidate snapshot, nothing else", () => {
    const snap = toTeaserSnapshot(person());
    expect(buildScreenState(NL_PROMPT, snap)).toEqual({
      targetAudience: NL_PROMPT,
      candidate: snap,
    });
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
