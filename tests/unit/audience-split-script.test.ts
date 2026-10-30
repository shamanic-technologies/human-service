import { describe, it, expect, vi, beforeEach } from "vitest";

// FACTORY-P3 next outcomes (audience_built): the split proposal, our own code recorded in the stored script's words,
// and the stored script proposing through our doors (our exact chat calls, spend on the script's run).
const completeJson = vi.fn();
const judgeChoices = vi.fn();
vi.mock("../../src/lib/chat-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/chat-client.js")>()),
  completeJson: (...a: unknown[]) => completeJson(...a),
  judgeChoices: (...a: unknown[]) => judgeChoices(...a),
}));
const recorded: Array<Record<string, unknown>> = [];
vi.mock("../../src/db/index.js", () => ({ db: { insert: () => ({ values: async (v: Record<string, unknown>) => void recorded.push(v) }) } }));
vi.mock("../../src/services/runs.js", () => ({ createRun: vi.fn(async () => "proposal-run"), completeRun: vi.fn(async () => undefined) }));
const switchState = vi.fn();
const runServiceScript = vi.fn();
vi.mock("../../src/lib/script-switch.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/script-switch.js")>()),
  scriptSwitch: (...a: unknown[]) => switchState(...a),
  runServiceScript: (...a: unknown[]) => runServiceScript(...a),
}));

const { proposeAudienceSplit, splitDoor, SPLIT_COMPLETE_CALL, SPLIT_JUDGE_CALL, buildSplitSystemPrompt } = await import("../../src/services/audience-split.js");
const { ChatServiceError } = await import("../../src/lib/chat-client.js");

const identity = { orgId: "org-1", userId: "u-1", runId: "caller-run" };
const WRITTEN = { axes: ["geography"], segments: [{ name: "US clinics", description: "Clinics in the US.", estimatedLeadCount: 1200 }, { name: "EU clinics", description: "Clinics in Europe.", estimatedLeadCount: 800 }] };
const ICONS = { segment_1: { choice: "globe-hemisphere-west", confidence: 0.9 }, segment_2: { choice: "globe-hemisphere-east", confidence: 0.8 } };

beforeEach(() => {
  vi.clearAllMocks();
  recorded.length = 0;
  completeJson.mockResolvedValue(WRITTEN);
  judgeChoices.mockResolvedValue(ICONS);
});

describe("our own split, recorded in the script's words", () => {
  it("records the exact completion request + answer and the icon judgment, on its own proposal run", async () => {
    switchState.mockResolvedValue({ switched: false, dynasty: null });
    const out = await proposeAudienceSplit("Clinics in the US and Europe", identity);
    expect(out.segments.map((s) => s.icon)).toEqual(["globe-hemisphere-west", "globe-hemisphere-east"]);
    expect(recorded).toHaveLength(1);
    const r = recorded[0]!;
    expect(r).toMatchObject({ path: "service", runId: "proposal-run", targetAudience: "Clinics in the US and Europe", allowEmpty: false, proposal: out, error: null });
    const calls = r.calls as Array<{ name: string; args: Record<string, unknown> }>;
    expect(calls.map((c) => c.name)).toEqual([SPLIT_COMPLETE_CALL, SPLIT_JUDGE_CALL]);
    expect(calls[0]!.args).toMatchObject({ message: "Clinics in the US and Europe", systemPrompt: buildSplitSystemPrompt(), provider: "anthropic", model: "sonnet", disableThinking: true });
  });
});

describe("the stored split proposes through our doors", () => {
  it("runs our exact calls with the spend on the script's run; a bad answer reaches the caller as our 502", async () => {
    switchState.mockResolvedValue({ switched: true, dynasty: "dy_split" });
    runServiceScript.mockImplementation(async (input: { units: { offer_described: { content: { proposal: string } } } }) => {
      const token = input.units.offer_described.content.proposal;
      const w = await splitDoor(token, "script-run", SPLIT_COMPLETE_CALL, { message: "T", systemPrompt: "S", provider: "anthropic", model: "sonnet", disableThinking: true });
      expect(w.status).toBe(200);
      const j = await splitDoor(token, "script-run", SPLIT_JUDGE_CALL, { state: { target: "T" }, questions: {} });
      expect(j.status).toBe(200);
      return { runId: "script-run", scriptSlug: "audience_built/dy_split/v1", content: { axes: [], segments: [] } };
    });
    const out = await proposeAudienceSplit("T", identity);
    expect(out).toEqual({ axes: [], segments: [] });
    expect((completeJson.mock.calls[0]![0] as { identity: { runId: string } }).identity.runId).toBe("script-run");
    expect(recorded[0]).toMatchObject({ path: "script", runId: "script-run" });

    const { ServiceScriptError } = await import("../../src/lib/script-switch.js");
    runServiceScript.mockRejectedValueOnce(new ServiceScriptError("LLM split returned 7 segments (expected 1-6)", "script-run", true));
    const err = await proposeAudienceSplit("T", identity).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatServiceError);
  });

  it("a door serves only a proposal in flight", async () => {
    expect((await splitDoor("nope", "r", SPLIT_COMPLETE_CALL, {})).status).toBe(409);
  });
});
