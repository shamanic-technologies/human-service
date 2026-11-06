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

const PLATFORM = { kind: "platform", name: "human-service" };
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
  it("the script whose run asked, else OUR system (platform, human-service), whoever started it (owner 2026-11-07)", () => {
    expect(listBuiltPerformer("lead-sourcing-v3")).toEqual({ kind: "script", workflowSlug: "lead-sourcing-v3" });
    expect(listBuiltPerformer(null)).toEqual(PLATFORM);
    expect(listBuiltPerformer(undefined)).toEqual(PLATFORM);
    expect(listBuiltPerformer("  ")).toEqual(PLATFORM);
  });

  it("a past run: the same rule, every task (portfolio launch included); never client_team", () => {
    expect(performerOfPastRun(null)).toEqual({ performer: PLATFORM });
    expect(performerOfPastRun("wf-1")).toEqual({ performer: { kind: "script", workflowSlug: "wf-1" } });
  });

  it("plans our occurrences per run with the same rule; every one states a performer", () => {
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
    expect(plan.statements.slice(0, 2)).toEqual([
      {
        runId: "r1",
        produced: [
          { outcomeKey: "audience_built", subjectService: "human-service", subjectId: "a1", performer: PLATFORM },
          { outcomeKey: "audience_built", subjectService: "human-service", subjectId: "a2", performer: PLATFORM },
        ],
      },
      { runId: "r2", produced: [{ outcomeKey: "audience_built", subjectService: "human-service", subjectId: "a3", performer: { kind: "script", workflowSlug: "wf-1" } }] },
    ]);
    expect(plan.statements).toHaveLength(4);
    expect(plan.statements.slice(2)).toEqual([
      { runId: "r6", produced: [{ outcomeKey: "audience_built", subjectService: "human-service", subjectId: "t1", performer: PLATFORM }] },
      { runId: "r7", produced: [{ outcomeKey: "audience_built", subjectService: "human-service", subjectId: "t2", performer: PLATFORM }] },
    ]);
  });

  it("batches stay inside the door's limits", () => {
    const s = (n: number, k: number) => ({ runId: `r${n}`, produced: Array.from({ length: k }, (_, i) => ({ outcomeKey: "audience_built", subjectService: "human-service", subjectId: `${n}-${i}`, performer: PLATFORM as never })) });
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
        if (url.includes("/internal/outcome-occurrences") && url.includes("performerKind=client_team")) {
          return Response.json({ occurrences: [occ({ runId: "rc", subjectId: "c1" }), occ({ runId: "rc", subjectId: "c1", serviceName: "lead-service" })], nextCursor: null });
        }
        if (url.includes("/internal/outcome-occurrences")) {
          const page2 = url.includes("cursor=c1");
          return Response.json({
            occurrences: page2
              ? [occ({ runId: "r2", subjectId: "b1" }), occ({ runId: "r9", subjectId: "t9", taskName: "audience-refill" })]
              : [occ({ runId: "r1", subjectId: "a1" })],
            nextCursor: page2 ? null : "c1",
          });
        }
        const b = JSON.parse(init.body!) as { runs: Array<{ correctPerformer?: boolean }> };
        return b.runs.some((r) => r.correctPerformer)
          ? Response.json({ recordedCount: 0, alreadyRecordedCount: 0, performerStatedCount: 0, performerCorrectedCount: 1 })
          : Response.json({ recordedCount: 0, alreadyRecordedCount: 0, performerStatedCount: 3 });
      });
    });

    it("dry run reads and counts, states nothing", async () => {
      const r = await completeListPerformers({ dryRun: true });
      expect(r).toMatchObject({ dryRun: true, runs: 4, occurrences: 4, toCorrect: 1, stated: 0, corrected: 0 });
      expect(calls.every((c) => c.url.includes("/internal/outcome-occurrences"))).toBe(true);
      expect(calls[0].url).toContain("performerKind=none");
      expect(calls.some((c) => c.url.includes("performerKind=client_team"))).toBe(true);
    });

    it("states the performer through the batch door, as the run's own service; the timer run included", async () => {
      const r = await completeListPerformers({ dryRun: false });
      expect(r).toMatchObject({ runs: 4, occurrences: 4, toCorrect: 1, stated: 3, corrected: 1, failedBatches: 0 });
      const posts = calls.filter((c) => c.url === "http://runs/v1/platform-runs/outcomes/batch");
      expect(posts).toHaveLength(2);
      const post = posts[0];
      // client_team moved to platform through the correction door, in its own call, ours only.
      expect(posts[1].body).toEqual({
        runs: [{ runId: "rc", correctPerformer: true, produced: [{ outcomeKey: "audience_built", subjectService: "human-service", subjectId: "c1", performer: PLATFORM }] }],
      });
      expect(post.headers["x-service-name"]).toBe("human-service");
      expect(post.body).toEqual({
        runs: [
          { runId: "r1", produced: [{ outcomeKey: "audience_built", subjectService: "human-service", subjectId: "a1", performer: PLATFORM }] },
          { runId: "r2", produced: [{ outcomeKey: "audience_built", subjectService: "human-service", subjectId: "b1", performer: PLATFORM }] },
          { runId: "r9", produced: [{ outcomeKey: "audience_built", subjectService: "human-service", subjectId: "t9", performer: PLATFORM }] },
        ],
      });
    });
  });
});
