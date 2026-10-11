import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));
const { decideLeadSourcing, NO_RETURN_SPEND_MULTIPLE } = await import("../../src/services/lead-sourcing.js");

const CF = "sourcing-apollo-cold-filters";
const BS = "sourcing-apollo-buying-signals";
const LI = "sourcing-linkedin-engagement-signals";
const ev = (leadsServed: number, positiveReplies: number, endToEndCostUsd: number) => ({ leadsServed, positiveReplies, endToEndCostUsd });

describe("Lead Sourcing decides which sources a brand uses, by measured ROI (owner 2026-10-11)", () => {
  it("nothing read yet: every source of the universe is used", () => {
    const d = decideLeadSourcing([CF, BS, LI], null);
    expect(d.chosen).toEqual([BS, CF, LI]);
    expect(Object.values(d.reasons).every((r) => r.reason === "no_evidence_read")).toBe(true);
  });

  it("no source has a positive reply yet: nothing can be compared, every source is kept (prod 933d4abb, 2026-10-11)", () => {
    const d = decideLeadSourcing([CF, BS, LI], new Map([[CF, ev(175, 0, 59)], [BS, ev(48, 0, 14)], [LI, ev(7, 0, 3)]]));
    expect(d.chosen).toEqual([BS, CF, LI]);
    expect(d.reasons[CF].reason).toBe("no_measured_source_yet");
  });

  it("a source that spent 3x the best source's cost per positive reply with none is dropped; one still learning stays (prod a179bbd9 shape)", () => {
    // Cold filters: 8 replies for $630 = $78.75 each. Buying signals: $33, no reply yet (< 3 x $78.75): still learning.
    const learning = decideLeadSourcing([CF, BS], new Map([[CF, ev(5664, 8, 630)], [BS, ev(355, 0, 33)]]));
    expect(learning.chosen).toEqual([BS, CF]);
    expect(learning.reasons[CF].reason).toBe("best_cost_per_positive_reply");
    expect(learning.reasons[BS]).toMatchObject({ chosen: true, reason: "still_learning", bestCostPerPositiveReplyUsd: 78.75 });
    // The same source once it spent 3 replies' worth at the best rate, still none: dropped.
    const dropped = decideLeadSourcing([CF, BS], new Map([[CF, ev(5664, 8, 630)], [BS, ev(900, 0, NO_RETURN_SPEND_MULTIPLE * 78.75)]]));
    expect(dropped.chosen).toEqual([CF]);
    expect(dropped.reasons[BS]).toMatchObject({ chosen: false, reason: "spent_without_positive_reply" });
  });

  it("a source with positive replies is never dropped (the picker shares runs by cost per outcome); never below one source", () => {
    const d = decideLeadSourcing([CF, BS], new Map([[CF, ev(100, 10, 100)], [BS, ev(100, 1, 400)]]));
    expect(d.chosen).toEqual([BS, CF]);
    expect(d.reasons[BS].reason).toBe("positive_replies_measured");
    const only = decideLeadSourcing([CF], new Map([[CF, ev(5000, 0, 9999)]]));
    expect(only.chosen).toEqual([CF]);
  });

  it("a source with no figure at all is still learning", () => {
    const d = decideLeadSourcing([CF, LI], new Map([[CF, ev(100, 2, 50)]]));
    expect(d.reasons[LI]).toMatchObject({ chosen: true, reason: "still_learning", evidence: null });
  });
});
