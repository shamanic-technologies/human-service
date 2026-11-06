import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listBuiltPerformer } from "../../src/services/runs.js";
import { performerOfPastRun } from "../../src/services/run-outcomes-backfill.js";
import {
  completeListPerformers,
  performerBatches,
  planPerformerStatements,
  type PastOccurrence,
} from "../../src/services/list-performer-completion.js";

const fetchBefore = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = fetchBefore;
});

const CLIENT = { kind: "client_team", name: "human-service" };
const occ = (p: Partial<PastOccurrence> & { runId: string; subjectId: string }): PastOccurrence => ({
  serviceName: "human-service",
  taskName: "audience-portfolio-launch",
  direction: "produced",
  outcomeKey: "audience_built",
  subjectService: "human-service",
  tags: { workflowSlug: null },
  ...p,
});

describe("who performed a list we built (OUTCOME-PERFORMER-1106)", () => {
  it("the script whose run asked, else the client's person who triggered it, else NOBODY (null); never a guess", () => {
    expect(listBuiltPerformer("lead-sourcing-v3", false)).toEqual({ kind: "script", workflowSlug: "lead-sourcing-v3" });
    expect(listBuiltPerformer("lead-sourcing-v3", true)).toEqual({ kind: "script", workflowSlug: "lead-sourcing-v3" });
    expect(listBuiltPerformer(null, true)).toEqual(CLIENT);
    expect(listBuiltPerformer(null, false)).toBeNull();
    expect(listBuiltPerformer("  ", false)).toBeNull();
  });

  it("a past run: client_team only for a task only a client's person triggers; timers and staff tasks state none", () => {
    expect(performerOfPastRun("audience-portfolio-launch", null)).toEqual({ performer: CLIENT });
    for (const t of ["audience-refill", "competitor-engagement-audience", "profile-signal-lists", "audience-pointer-build", "source-campaign-audience"]) {
      expect(performerOfPastRun(t, null)).toEqual({});
    }
    expect(performerOfPastRun("audience-refill", "wf-1")).toEqual({ performer: { kind: "script", workflowSlug: "wf-1" } });
  });

  it("plans our occurrences per run with the same rule; a nameless one is counted unknown, never sent", () => {
    const plan = planPerformerStatements([
      occ({ runId: "r1", subjectId: "a1" }),
      occ({ runId: "r1", subjectId: "a2" }),
      occ({ runId: "r1", subjectId: "a2" }),
      occ({ runId: "r2", subjectId: "a3", taskName: "audience-refill", tags: { workflowSlug: "wf-1" } }),
      occ({ runId: "r6", subjectId: "t1", taskName: "audience-refill" }),
      occ({ runId: "r7", subjectId: "t2", taskName: "competitor-engagement-audience" }),
      occ({ runId: "r3", subjectId: "x", serviceName: "lead-service" }),
      occ({ runId: "r4", subjectId: "y", direction: "consumed" }),
      occ({ runId: "r5", subjectId: "z", outcomeKey: "lead_found" }),
    ]);
    expect(plan.statements).toEqual([
      {
        runId: "r1",
        produced: [
          { outcomeKey: "audience_built", subjectService: "human-service", subjectId: "a1", performer: CLIENT },
          { outcomeKey: "audience_built", subjectService: "human-service", subjectId: "a2", performer: CLIENT },
        ],
      },
      { runId: "r2", produced: [{ outcomeKey: "audience_built", subjectService: "human-service", subjectId: "a3", performer: { kind: "script", workflowSlug: "wf-1" } }] },
    ]);
    expect(plan.unknown).toEqual([
      { runId: "r6", taskName: "audience-refill", subjectId: "t1" },
      { runId: "r7", taskName: "competitor-engagement-audience", subjectId: "t2" },
    ]);
  });

  it("batches stay inside the door's limits", () => {
    const s = (n: number, k: number) => ({ runId: `r${n}`, produced: Array.from({ length: k }, (_, i) => ({ outcomeKey: "audience_built", subjectService: "human-service", subjectId: `${n}-${i}`, performer: CLIENT as never })) });
    expect(performerBatches([s(1, 600), s(2, 600)]).map((b) => b.length)).toEqual([1, 1]);
    expect(performerBatches(Array.from({ length: 501 }, (_, i) => s(i, 1))).map((b) => b.length)).toEqual([500, 1]);
  });

  describe("the pass", () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    beforeEach(() => {
      calls.length = 0;
      process.env.RUNS_SERVICE_URL = "http://runs";
      process.env.RUNS_SERVICE_API_KEY = "k";
      vi.stubGlobal("fetch", async (url: string, init: { body?: string; headers: Record<string, string> }) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
        if (url.includes("/internal/outcome-occurrences")) {
          const page2 = url.includes("cursor=c1");
          return Response.json({
            occurrences: page2
              ? [occ({ runId: "r2", subjectId: "b1" }), occ({ runId: "r9", subjectId: "t9", taskName: "audience-refill" })]
              : [occ({ runId: "r1", subjectId: "a1" })],
            nextCursor: page2 ? null : "c1",
          });
        }
        return Response.json({ recordedCount: 0, alreadyRecordedCount: 0, performerStatedCount: 2 });
      });
    });

    it("dry run reads and counts, states nothing", async () => {
      const r = await completeListPerformers({ dryRun: true });
      expect(r).toMatchObject({ dryRun: true, runs: 2, occurrences: 2, performerUnknown: 1, stated: 0 });
      expect(calls.every((c) => c.url.includes("/internal/outcome-occurrences"))).toBe(true);
      expect(calls[0].url).toContain("performerKind=none");
    });

    it("states the performer through the batch door, as the run's own service; the timer run is not sent", async () => {
      const r = await completeListPerformers({ dryRun: false });
      expect(r).toMatchObject({ runs: 2, occurrences: 2, performerUnknown: 1, stated: 2, failedBatches: 0 });
      const post = calls.find((c) => c.url === "http://runs/v1/platform-runs/outcomes/batch")!;
      expect(post.headers["x-service-name"]).toBe("human-service");
      expect(post.body).toEqual({
        runs: [
          { runId: "r1", produced: [{ outcomeKey: "audience_built", subjectService: "human-service", subjectId: "a1", performer: CLIENT }] },
          { runId: "r2", produced: [{ outcomeKey: "audience_built", subjectService: "human-service", subjectId: "b1", performer: CLIENT }] },
        ],
      });
    });
  });
});
