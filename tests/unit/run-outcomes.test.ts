import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addRunOutputs, noteListBuilt, takeRunOutputs, withRunOutputs } from "../../src/services/run-outputs.js";
import {
  attributeLists,
  batchesOf,
  coverageByDay,
  pairVerifyRuns,
  supportMarkCalls,
  planRunOutcomes,
  type BuiltList,
  type PastRun,
  type ServeRow,
} from "../../src/services/run-outcomes-backfill.js";

const fetchBefore = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = fetchBefore;
});

function run(p: Partial<PastRun> & { id: string; taskName: string }): PastRun {
  return {
    parentRunId: null,
    organizationId: "org-1",
    brandIds: ["brand-1"],
    audienceId: null,
    status: "completed",
    startedAt: "2026-10-01T10:00:00.000Z",
    completedAt: "2026-10-01T10:01:00.000Z",
    costCents: 1,
    ...p,
  };
}

describe("run outputs: what a run we opened built", () => {
  const tick = () => new Promise((r) => setTimeout(r, 1));

  it("collects the lists built under each run, and nothing its caller builds", async () => {
    async function ownRun(runId: string, lists: string[]) {
      await tick(); // stands for `await createRun(...)`
      await withRunOutputs(runId, async () => {
        for (const l of lists) {
          await tick();
          noteListBuilt(l);
        }
      });
    }
    await ownRun("run-a", ["a1", "a2"]);
    await Promise.all([ownRun("run-b", ["b1"]), ownRun("run-c", ["c1"])]);
    // The caller is in no run's context: this list is nobody's.
    noteListBuilt("outside");
    expect(takeRunOutputs("run-a").sort()).toEqual(["a1", "a2"]);
    expect(takeRunOutputs("run-b")).toEqual(["b1"]);
    expect(takeRunOutputs("run-c")).toEqual(["c1"]);
    expect(takeRunOutputs("run-a")).toEqual([]);
  });

  it("a nested own run keeps its own set; two scopes of one run share one", async () => {
    await withRunOutputs("outer", async () => {
      noteListBuilt("o1");
      await withRunOutputs("inner", async () => noteListBuilt("i1"));
      noteListBuilt("o2");
    });
    await withRunOutputs("outer", async () => noteListBuilt("o3"));
    addRunOutputs("outer", ["o4"]);
    expect(takeRunOutputs("outer").sort()).toEqual(["o1", "o2", "o3", "o4"]);
    expect(takeRunOutputs("inner")).toEqual(["i1"]);
  });

  it("a list built after the run closed is logged, never declared", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await withRunOutputs("late", async () => {
      noteListBuilt("x");
      takeRunOutputs("late");
      noteListBuilt("x"); // already declared: silent
      noteListBuilt("y");
    });
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("list=y");
    err.mockRestore();
  });

  describe("completeRun declares the run's lists", () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    beforeEach(() => {
      calls.length = 0;
      process.env.RUNS_SERVICE_URL = "http://runs";
      process.env.RUNS_SERVICE_API_KEY = "k";
      vi.stubGlobal("fetch", async (url: string, init: { body?: string; headers: Record<string, string> }) => {
        calls.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
        return new Response("{}", { status: 201 });
      });
    });

    it("posts audience_built for each list, then closes the run", async () => {
      const { completeRun } = await import("../../src/services/runs.js");
      await withRunOutputs("run-x", async () => {
        noteListBuilt("aud-1");
        noteListBuilt("src-1");
      });
      await completeRun("run-x", "completed", { orgId: "org-1", userId: "user-1" });
      expect(calls.map((c) => c.url)).toEqual(["http://runs/v1/runs/run-x/outcomes", "http://runs/v1/runs/run-x"]);
      expect(calls[0].headers["x-org-id"]).toBe("org-1");
      expect(calls[0].body).toEqual({
        produced: [
          { outcomeKey: "audience_built", subjectService: "human-service", subjectId: "aud-1" },
          { outcomeKey: "audience_built", subjectService: "human-service", subjectId: "src-1" },
        ],
      });
    });

    it("a run that built nothing declares nothing", async () => {
      const { completeRun } = await import("../../src/services/runs.js");
      await withRunOutputs("run-empty", async () => undefined);
      await completeRun("run-empty", "completed", { orgId: "org-1", userId: "user-1" });
      expect(calls.map((c) => c.url)).toEqual(["http://runs/v1/runs/run-empty"]);
    });

    it("a no-outcome-by-design task is marked support at creation; a list-building one is not", async () => {
      const { createRun, TASK_SUPPORT } = await import("../../src/services/runs.js");
      await createRun({ orgId: "org-1", userId: "user-1", taskName: "audience-split-estimate", support: TASK_SUPPORT["audience-split-estimate"] });
      await createRun({ orgId: "org-1", userId: "user-1", taskName: "audience-refill" });
      expect(calls[0].body).toEqual({
        serviceName: "human-service",
        taskName: "audience-split-estimate",
        support: { kind: "product_feature", reason: TASK_SUPPORT["audience-split-estimate"].reason },
      });
      expect(calls[1].body).toEqual({ serviceName: "human-service", taskName: "audience-refill" });
      expect(Object.keys(TASK_SUPPORT).sort()).toEqual(["audience-preview-companies", "audience-split-estimate", "audience-target-draft"]);
    });
  });
});

describe("backfill planning", () => {
  const serve = (p: Partial<ServeRow> & { id: string }): ServeRow => ({
    runId: "parent-1",
    orgId: "org-1",
    brandId: "brand-1",
    email: `${p.id}@x.com`,
    verdict: "valid",
    servedAt: new Date("2026-09-25T00:00:10.000Z"),
    ...p,
  });

  it("pairs each verify run with the serve row its parent wrote right after it, in order", () => {
    const runs = [
      run({ id: "v2", taskName: "verify-email", parentRunId: "parent-1", startedAt: "2026-09-25T00:00:20.000Z" }),
      run({ id: "v1", taskName: "verify-email", parentRunId: "parent-1", startedAt: "2026-09-25T00:00:05.000Z" }),
    ];
    const serves = [
      serve({ id: "s1", servedAt: new Date("2026-09-25T00:00:10.000Z") }),
      serve({ id: "s2", servedAt: new Date("2026-09-25T00:00:25.000Z") }),
      serve({ id: "other", runId: "parent-2", servedAt: new Date("2026-09-25T00:00:06.000Z") }),
    ];
    const pairs = pairVerifyRuns(runs, serves);
    expect(pairs.get("v1")?.id).toBe("s1");
    expect(pairs.get("v2")?.id).toBe("s2");
  });

  it("a free check (unknown verdict, no charge) is email_checked too and keeps its own verdict row", () => {
    const runs = [
      run({ id: "free", taskName: "verify-email", parentRunId: "parent-1", costCents: 0, startedAt: "2026-09-25T00:00:05.000Z" }),
      run({ id: "paid", taskName: "verify-email", parentRunId: "parent-1", startedAt: "2026-09-25T00:00:20.000Z" }),
      run({ id: "dead", taskName: "verify-email", parentRunId: "parent-1", costCents: 0, status: "failed", startedAt: "2026-09-25T00:00:40.000Z" }),
    ];
    const serves = [
      serve({ id: "s-unknown", servedAt: new Date("2026-09-25T00:00:10.000Z"), verdict: "unknown" }),
      serve({ id: "s-valid", servedAt: new Date("2026-09-25T00:00:25.000Z"), verdict: "valid" }),
    ];
    const pairs = pairVerifyRuns(runs.filter((r) => r.costCents > 0 || r.status === "completed"), serves);
    expect(pairs.get("free")?.id).toBe("s-unknown");
    expect(pairs.get("paid")?.id).toBe("s-valid");
    const { planned, notDeclared } = planRunOutcomes({
      runs,
      pointerAudiencesWithPointer: new Set(),
      verifyPairs: pairs,
      leadOf: (s) => `lead-of-${s.id}`,
      lists: [],
    });
    expect(planned.map((p) => [p.runId, p.produced[0].subjectId])).toEqual([
      ["free", "lead-of-s-unknown"],
      ["paid", "lead-of-s-valid"],
    ]);
    expect(notDeclared).toEqual([]);
  });

  it("a kept verdict declares email_checked on the lead; a rejected one is a loss", () => {
    const runs = [
      run({ id: "v1", taskName: "verify-email", parentRunId: "parent-1", startedAt: "2026-09-25T00:00:05.000Z" }),
      run({ id: "v2", taskName: "verify-email", parentRunId: "parent-1", startedAt: "2026-09-25T00:00:20.000Z" }),
    ];
    const serves = [
      serve({ id: "s1", servedAt: new Date("2026-09-25T00:00:10.000Z"), verdict: "catch_all" }),
      serve({ id: "s2", servedAt: new Date("2026-09-25T00:00:25.000Z"), verdict: "invalid" }),
    ];
    const { planned, notDeclared } = planRunOutcomes({
      runs,
      pointerAudiencesWithPointer: new Set(),
      verifyPairs: pairVerifyRuns(runs, serves),
      leadOf: () => "lead-1",
      lists: [],
    });
    expect(planned).toEqual([
      {
        runId: "v1",
        taskName: "verify-email",
        costCents: 1,
        produced: [{ outcomeKey: "email_checked", subjectService: "lead-service", subjectId: "lead-1" }],
        consumed: [{ outcomeKey: "email_found", subjectService: "lead-service", subjectId: "lead-1" }],
      },
    ]);
    expect(notDeclared.map((n) => [n.runId, n.reason])).toEqual([["v2", "verdict_not_kept"]]);
  });

  it("every completed pointer build of an audience holding a pointer declares it (a duplicate is the ledger's repeat)", () => {
    const runs = [
      run({ id: "p-failed", taskName: "audience-pointer-build", audienceId: "aud-1", status: "failed", startedAt: "2026-10-01T09:00:00.000Z" }),
      run({ id: "p-first", taskName: "audience-pointer-build", audienceId: "aud-1", startedAt: "2026-10-01T10:00:00.000Z" }),
      run({ id: "p-again", taskName: "audience-pointer-build", audienceId: "aud-1", startedAt: "2026-10-01T10:05:00.000Z" }),
      run({ id: "p-none", taskName: "audience-pointer-build", audienceId: "aud-2" }),
    ];
    const { planned, notDeclared } = planRunOutcomes({
      runs,
      pointerAudiencesWithPointer: new Set(["aud-1"]),
      verifyPairs: new Map(),
      leadOf: () => null,
      lists: [],
    });
    expect(planned.map((p) => [p.runId, p.produced[0].subjectId])).toEqual([
      ["p-first", "aud-1"],
      ["p-again", "aud-1"],
    ]);
    expect(Object.fromEntries(notDeclared.map((n) => [n.runId, n.reason]))).toEqual({
      "p-failed": "no_list_built",
      "p-none": "no_list_built",
    });
  });

  it("a list-building run declares the lists created in its window; a list two runs could have made is nobody's", () => {
    const refill = run({ id: "refill", taskName: "audience-refill" });
    const a = run({ id: "launch-a", taskName: "audience-portfolio-launch", startedAt: "2026-10-03T08:51:47.000Z", completedAt: "2026-10-03T08:53:00.000Z" });
    const b = run({ id: "launch-b", taskName: "audience-portfolio-launch", startedAt: "2026-10-03T08:52:00.000Z", completedAt: "2026-10-03T08:53:00.000Z" });
    const list = (id: string, kind: string, at: string, brandId = "brand-1"): BuiltList => ({ id, orgId: "org-1", brandId, kind, createdAt: new Date(at) });
    const lists = [
      list("r1", "auto_refill", "2026-10-01T10:00:09.000Z"),
      list("r-other-brand", "auto_refill", "2026-10-01T10:00:09.000Z", "brand-2"),
      list("r-wrong-kind", "split_proposal", "2026-10-01T10:00:09.000Z"),
      list("cold", "icp_portfolio", "2026-10-03T08:51:51.000Z"),
      list("signal", "icp_portfolio_signal", "2026-10-03T08:52:31.000Z"),
      list("src", "source:apollo_buying_signal", "2026-10-03T08:51:52.000Z"),
    ];
    const { byRun, shared } = attributeLists([refill, a, b], lists);
    expect(byRun.get("refill")).toEqual(["r1"]);
    expect(byRun.get("launch-a")?.sort()).toEqual(["cold", "src"]);
    expect(byRun.get("launch-b")).toBeUndefined();
    expect([...shared].sort()).toEqual(["launch-a", "launch-b"]);

    const { planned, notDeclared, support } = planRunOutcomes({
      runs: [refill, a, b, run({ id: "draft", taskName: "audience-target-draft" }), run({ id: "probe", taskName: "prompt-test" }), run({ id: "mystery", taskName: "some-new-task" }), run({ id: "free", taskName: "audience-refill", costCents: 0, startedAt: "2026-10-02T10:00:00.000Z", completedAt: "2026-10-02T10:01:00.000Z" })],
      pointerAudiencesWithPointer: new Set(),
      verifyPairs: new Map(),
      leadOf: () => null,
      lists,
    });
    expect(planned.map((p) => [p.runId, p.produced.map((o) => o.subjectId)])).toEqual([
      ["refill", ["r1"]],
      ["launch-a", ["cold", "src"]],
    ]);
    expect(Object.fromEntries(notDeclared.map((n) => [n.runId, n.reason]))).toEqual({
      "launch-b": "list_shared_with_another_run",
      mystery: "unclassified",
    });
    expect(support.map((x) => [x.runId, x.support.kind])).toEqual([
      ["draft", "product_feature"],
      ["probe", "staff_experiment"],
    ]);
  });

  it("support tasks are marked whatever they spent; marks group by function, <= 5000 per call", () => {
    const runs = [
      run({ id: "e0", taskName: "audience-split-estimate", costCents: 0 }),
      run({ id: "e1", taskName: "audience-split-estimate" }),
      run({ id: "pc", taskName: "audience-preview-companies" }),
      run({ id: "x1", taskName: "verify-chooser" }),
    ];
    const plan = planRunOutcomes({ runs, pointerAudiencesWithPointer: new Set(), verifyPairs: new Map(), leadOf: () => null, lists: [] });
    expect(plan.planned).toEqual([]);
    expect(plan.notDeclared).toEqual([]);
    expect(plan.support.map((x) => x.runId)).toEqual(["e0", "e1", "pc", "x1"]);
    const calls = supportMarkCalls(plan.support);
    expect(calls.map((c) => [c.support.kind, c.runIds])).toEqual([
      ["product_feature", ["e0", "e1"]],
      ["product_feature", ["pc"]],
      ["staff_experiment", ["x1"]],
    ]);
    const many = Array.from({ length: 5001 }, (_, i) => ({ runId: `r${String(i).padStart(5, "0")}`, taskName: "prompt-test", costCents: 0, startedAt: "2026-10-01T00:00:00.000Z", support: { kind: "staff_experiment" as const, reason: "x" } }));
    expect(supportMarkCalls(many).map((c) => c.runIds.length)).toEqual([5000, 1]);
  });

  it("every cent of a day lands on a declared occurrence, a support mark or a run with no output", () => {
    const runs = [
      run({ id: "v-kept", taskName: "verify-email", parentRunId: "parent-1", costCents: 0.5, startedAt: "2026-09-25T00:00:05.000Z" }),
      run({ id: "v-lost", taskName: "verify-email", parentRunId: "parent-1", costCents: 0.25, startedAt: "2026-09-25T00:00:20.000Z" }),
      run({ id: "draft", taskName: "audience-target-draft", costCents: 2, startedAt: "2026-09-25T09:00:00.000Z" }),
      run({ id: "odd", taskName: "some-new-task", costCents: 1, startedAt: "2026-09-26T09:00:00.000Z" }),
    ];
    const serves = [
      serve({ id: "s1", servedAt: new Date("2026-09-25T00:00:10.000Z"), verdict: "valid" }),
      serve({ id: "s2", servedAt: new Date("2026-09-25T00:00:25.000Z"), verdict: "invalid" }),
    ];
    const plan = planRunOutcomes({ runs, pointerAudiencesWithPointer: new Set(), verifyPairs: pairVerifyRuns(runs, serves), leadOf: () => "lead-1", lists: [] });
    const at = new Map(runs.map((r) => [r.id, r.startedAt]));
    expect(coverageByDay(plan, (id) => at.get(id)!)).toEqual({
      "2026-09-25": { spendCents: 2.75, declaredCents: 0.5, supportCents: 2, noOutputCents: 0.25, unclassifiedCents: 0 },
      "2026-09-26": { spendCents: 1, declaredCents: 0, supportCents: 0, noOutputCents: 0, unclassifiedCents: 1 },
    });
  });

  it("batches stay within 500 runs and 1000 occurrences", () => {
    const p = (n: number) => ({ runId: `r${n}`, taskName: "t", costCents: 1, produced: Array.from({ length: 300 }, (_, i) => ({ outcomeKey: "audience_built", subjectService: "human-service", subjectId: `${n}-${i}` })), consumed: [] });
    expect(batchesOf([p(1), p(2), p(3), p(4)]).map((b) => b.length)).toEqual([3, 1]);
    const small = Array.from({ length: 1001 }, (_, i) => ({ runId: `s${i}`, taskName: "t", costCents: 1, produced: [], consumed: [] }));
    expect(batchesOf(small).map((b) => b.length)).toEqual([500, 500, 1]);
  });
});
