// OUTCOME-PERFORMER-1106: complete, ONCE, the `audience_built` occurrences we declared before we stated
// who performed them.
//
// runs-service stores the performer per occurrence (`produced[].performer`); an occurrence recorded without
// one takes a stated one once (`performer_stated`), the same again is `already_recorded`, another one is a
// 409 `performer_conflict` (never overwritten). This pass reads OUR `audience_built` occurrences that have
// no performer (`GET /internal/outcome-occurrences?performerKind=none`), states the one the live
// declaration's rule gives (`performerOfPastRun`: script, else platform = our own system, owner 2026-11-07),
// through the batch door, per run. An occurrence already stored with another performer (e.g. client_team)
// is never read here (`performerKind=none`) and never overwritten.
// No `occurredAt`: an already recorded occurrence keeps its date.
//
// Runs on its own (boot + 60 s, then every 6 h): once every occurrence has its performer the read answers
// nothing and the pass does nothing. Nothing is stored here; a refused batch is logged loud and retried on
// the next pass (a 409 conflict would repeat: logged with the runs, never forced).
import { AUDIENCE_BUILT, SUBJECT_SERVICE, type OutcomePerformer } from "./runs.js";
import { performerOfPastRun } from "./run-outcomes-backfill.js";

export interface PastOccurrence {
  runId: string;
  serviceName: string;
  taskName: string;
  direction: string;
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  tags?: { workflowSlug?: string | null } | null;
}

export interface PerformerStatement {
  runId: string;
  produced: Array<{ outcomeKey: string; subjectService: string; subjectId: string; performer: OutcomePerformer }>;
}

export interface PerformerPlan {
  statements: PerformerStatement[];
}

/**
 * Our `audience_built` occurrences, grouped per run, each with the performer the live rule states for that run
 * (`performerOfPastRun`: the run's script, else platform).
 */
export function planPerformerStatements(occurrences: PastOccurrence[]): PerformerPlan {
  const byRun = new Map<string, PerformerStatement>();
  const seen = new Set<string>();
  for (const o of occurrences) {
    if (o.serviceName !== SUBJECT_SERVICE || o.direction !== "produced" || o.outcomeKey !== AUDIENCE_BUILT) continue;
    if (o.subjectService !== SUBJECT_SERVICE) continue;
    const key = `${o.runId}|${o.subjectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { performer } = performerOfPastRun(o.tags?.workflowSlug);
    let s = byRun.get(o.runId);
    if (!s) {
      s = { runId: o.runId, produced: [] };
      byRun.set(o.runId, s);
    }
    s.produced.push({ outcomeKey: AUDIENCE_BUILT, subjectService: SUBJECT_SERVICE, subjectId: o.subjectId, performer });
  }
  return { statements: [...byRun.values()] };
}

/** Batch door limits: <= 500 runs and <= 1000 occurrences per call. */
export function performerBatches(statements: PerformerStatement[], maxRuns = 500, maxOccurrences = 1000): PerformerStatement[][] {
  const out: PerformerStatement[][] = [];
  let cur: PerformerStatement[] = [];
  let n = 0;
  for (const s of statements) {
    if (cur.length > 0 && (cur.length >= maxRuns || n + s.produced.length > maxOccurrences)) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(s);
    n += s.produced.length;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function runsEnv(): { url: string; key: string } | null {
  const url = process.env.RUNS_SERVICE_URL;
  const key = process.env.RUNS_SERVICE_API_KEY;
  return url && key ? { url, key } : null;
}

/** Every `audience_built` occurrence runs-service holds with no performer (any service: filtered to ours by the plan). */
async function readUnperformed(env: { url: string; key: string }): Promise<PastOccurrence[]> {
  const out: PastOccurrence[] = [];
  let cursor: string | null = null;
  for (;;) {
    const q = new URLSearchParams({ outcomeKey: AUDIENCE_BUILT, direction: "produced", performerKind: "none", limit: "1000" });
    if (cursor) q.set("cursor", cursor);
    const res = await fetch(`${env.url}/internal/outcome-occurrences?${q}`, {
      headers: { "x-api-key": env.key },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`GET /internal/outcome-occurrences ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { occurrences?: PastOccurrence[]; nextCursor?: string | null };
    if (!Array.isArray(body.occurrences)) throw new Error("GET /internal/outcome-occurrences answered no occurrences array");
    out.push(...body.occurrences);
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return out;
}

export interface PerformerCompletionResult {
  dryRun: boolean;
  runs: number;
  occurrences: number;
  stated: number;
  alreadyRecorded: number;
  failedBatches: number;
}

export async function completeListPerformers(opts: { dryRun: boolean }): Promise<PerformerCompletionResult | null> {
  const env = runsEnv();
  if (!env) return null;
  const { statements: plan } = planPerformerStatements(await readUnperformed(env));
  const result: PerformerCompletionResult = {
    dryRun: opts.dryRun,
    runs: plan.length,
    occurrences: plan.reduce((n, s) => n + s.produced.length, 0),
    stated: 0,
    alreadyRecorded: 0,
    failedBatches: 0,
  };
  if (opts.dryRun || plan.length === 0) return result;
  for (const batch of performerBatches(plan)) {
    const res = await fetch(`${env.url}/v1/platform-runs/outcomes/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.key, "x-service-name": SUBJECT_SERVICE },
      body: JSON.stringify({ runs: batch }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      result.failedBatches += 1;
      console.error(
        `[human-service] list_performers.batch_failed status=${res.status} runs=${batch.map((b) => b.runId).join(",")}: ${(await res.text()).slice(0, 500)}`
      );
      continue;
    }
    const body = (await res.json()) as { performerStatedCount?: number; alreadyRecordedCount?: number };
    result.stated += body.performerStatedCount ?? 0;
    result.alreadyRecorded += body.alreadyRecordedCount ?? 0;
  }
  return result;
}

const INITIAL_DELAY_MS = 60_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Boot + 60 s, then every 6 h. Timers only (safe right after listen). */
export function startListPerformerCompletion(): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void completeListPerformers({ dryRun: false })
      .then((r) => {
        if (r && r.occurrences > 0) console.log(`[human-service] list_performers.completed ${JSON.stringify(r)}`);
      })
      .catch((err) => console.error("[human-service] list_performers.failed", err))
      .finally(() => {
        running = false;
      });
  };
  let repeat: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    tick();
    repeat = setInterval(tick, INTERVAL_MS);
    repeat.unref?.();
  }, INITIAL_DELAY_MS);
  first.unref?.();
  return () => {
    clearTimeout(first);
    if (repeat) clearInterval(repeat);
  };
}
