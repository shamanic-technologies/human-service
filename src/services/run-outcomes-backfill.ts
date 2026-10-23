// COST-BACKFILL-1023-HUMAN: declare the outcomes of human-service's PAST runs.
//
// Owner 2026-10-23: « chaque service peut rétro-engineerer pour estimer tous les
// coûts du passé pour être à 100 % now ». Not an estimate: our own rows say what
// each past run produced. Each run is read from runs-service (its API, per org),
// matched to the rows it wrote here, and declared through runs-service's
// backfill door (`POST /v1/platform-runs/outcomes/batch`, `occurredAt:
// "run_started_at"`), so a declaration behaves as if made when the run ran.
//
// What a past run produced, by task (the only runs that ever spent):
//   verify-email (2026-09-25, when human-service verified emails itself, v0.46.3)
//       ⟹ produced `email_checked`, consumed `email_found`, subject = the
//         person's LEAD (lead-service resolves it). Paired with the serve row it
//         wrote: the bronze `lead_serves` row of the same parent (lead-service's
//         serve run) whose served_at follows the run's start, in order (measured
//         2026-10-23: 1006/1006 paid runs pair, every gap <= 0.4 s). A verdict
//         not kept (invalid, risky) is a loss: nothing declared, its cost rolls
//         to the serve that bought it.
//   audience-pointer-build ⟹ `audience_built` of the run's own audienceId, by the
//         FIRST completed build of that audience (a later build's result was
//         discarded by the "pointer still empty" guard: produced nothing).
//   audience-refill, audience-portfolio-launch, source-campaign-audience,
//   competitor-engagement-audience, profile-signal-lists ⟹ `audience_built` of
//         every list (audience row or audience source) the run CREATED: same org,
//         one of the run's brands, a source tag that task writes, created between
//         the run's start and end. A list created inside the window of TWO
//         list-building runs is not attributable to one: not declared, reported.
//   audience-target-draft ⟹ NOT declared: it writes the target text of audiences
//         created afterwards by another step, never one list of its own. Reported.
//   Every other task is a staff experiment (support function, never an outcome).
//
// Only runs that SPENT are declared (subtree cost > 0); a declaration is
// idempotent on runs-service's side, so a re-run writes nothing new.
import { and, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audienceSources, audiences, leadServes } from "../db/schema.js";
import { AUDIENCE_BUILT, SUBJECT_SERVICE } from "./runs.js";

export const LEAD_SUBJECT_SERVICE = "lead-service";
/** Verdicts whose check is KEPT (fleet doctrine, same as apollo-service). */
export const KEPT_VERDICTS = new Set(["valid", "catch_all", "unknown"]);

/** The list sources (audiences.source) each list-building task writes. */
export const LIST_TASK_SOURCES: Record<string, string[]> = {
  "audience-refill": ["auto_refill"],
  "audience-portfolio-launch": ["icp_portfolio", "icp_portfolio_signal", "linkedin_engagement_signal"],
  "source-campaign-audience": ["source_campaign", "split_proposal", "icp_portfolio_signal", "linkedin_engagement_signal"],
  "competitor-engagement-audience": ["linkedin_engagement_signal"],
  "profile-signal-lists": ["icp_portfolio_signal"],
};
/** The audience_sources lists each task writes. */
export const LIST_TASK_SOURCE_LISTS: Record<string, string[]> = {
  "audience-portfolio-launch": ["apollo_buying_signal", "linkedin_engagement"],
  "source-campaign-audience": ["apollo_buying_signal", "linkedin_engagement"],
  "competitor-engagement-audience": ["linkedin_engagement"],
  "profile-signal-lists": ["apollo_buying_signal"],
};
const PRODUCT_TASKS = new Set([
  "verify-email",
  "audience-pointer-build",
  "audience-target-draft",
  "audience-split-estimate",
  "audience-preview-companies",
  ...Object.keys(LIST_TASK_SOURCES),
]);

export interface PastRun {
  id: string;
  parentRunId: string | null;
  organizationId: string;
  brandIds: string[];
  audienceId: string | null;
  taskName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  /** Billed subtree cost, cents. */
  costCents: number;
}

export interface Occurrence {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
}

export interface PlannedRun {
  runId: string;
  taskName: string;
  costCents: number;
  produced: Occurrence[];
  consumed: Occurrence[];
}

/** Why a spending run is not declared. */
export type NotDeclaredReason =
  | "staff_experiment"
  | "not_completed"
  | "no_list_built"
  | "list_shared_with_another_run"
  | "duplicate_build"
  | "text_for_lists_built_elsewhere"
  | "estimate_only"
  | "preview_only"
  | "verdict_not_kept"
  | "no_serve_row"
  | "lead_not_found";

export interface NotDeclared {
  runId: string;
  taskName: string;
  costCents: number;
  reason: NotDeclaredReason;
}

// --- Pure planning -------------------------------------------------------------------------

export interface ServeRow {
  id: string;
  runId: string | null;
  orgId: string;
  brandId: string;
  email: string | null;
  verdict: string | null;
  servedAt: Date;
}

/**
 * Pair each paid verify-email run with the serve row it wrote: per parent run, in
 * start order, the first unused verdict-bearing row served at or after the run's start.
 */
export function pairVerifyRuns(runs: PastRun[], serves: ServeRow[]): Map<string, ServeRow | null> {
  const byParent = new Map<string, ServeRow[]>();
  for (const s of serves) {
    if (!s.runId || !s.verdict) continue;
    const list = byParent.get(s.runId) ?? [];
    list.push(s);
    byParent.set(s.runId, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.servedAt.getTime() - b.servedAt.getTime());
  const out = new Map<string, ServeRow | null>();
  const used = new Set<string>();
  const ordered = [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  for (const r of ordered) {
    const candidates = r.parentRunId ? byParent.get(r.parentRunId) ?? [] : [];
    const start = Date.parse(r.startedAt);
    const hit = candidates.find((s) => !used.has(s.id) && s.servedAt.getTime() >= start) ?? null;
    if (hit) used.add(hit.id);
    out.set(r.id, hit);
  }
  return out;
}

export interface BuiltList {
  id: string;
  orgId: string;
  brandId: string;
  /** audiences.source, or `source:<list>` for an audience_sources row. */
  kind: string;
  createdAt: Date;
}

function writesKind(task: string, kind: string): boolean {
  if (kind.startsWith("source:")) return (LIST_TASK_SOURCE_LISTS[task] ?? []).includes(kind.slice("source:".length));
  return (LIST_TASK_SOURCES[task] ?? []).includes(kind);
}

function inWindow(run: PastRun, list: BuiltList): boolean {
  if (!run.completedAt) return false;
  const t = list.createdAt.getTime();
  return (
    list.orgId === run.organizationId &&
    run.brandIds.includes(list.brandId) &&
    writesKind(run.taskName, list.kind) &&
    t >= Date.parse(run.startedAt) &&
    t <= Date.parse(run.completedAt)
  );
}

/** The lists each list-building run created; a list inside two runs' windows is attributed to neither. */
export function attributeLists(runs: PastRun[], lists: BuiltList[]): { byRun: Map<string, string[]>; shared: Set<string> } {
  const builders = runs.filter((r) => r.taskName in LIST_TASK_SOURCES);
  const owners = new Map<string, string[]>();
  for (const l of lists) {
    const hits = builders.filter((r) => inWindow(r, l)).map((r) => r.id);
    if (hits.length > 0) owners.set(l.id, hits);
  }
  const byRun = new Map<string, string[]>();
  const shared = new Set<string>();
  for (const [listId, runIds] of owners) {
    if (runIds.length > 1) {
      for (const r of runIds) shared.add(r);
      continue;
    }
    const list = byRun.get(runIds[0]) ?? [];
    list.push(listId);
    byRun.set(runIds[0], list);
  }
  return { byRun, shared };
}

const audienceBuilt = (subjectId: string): Occurrence => ({ outcomeKey: AUDIENCE_BUILT, subjectService: SUBJECT_SERVICE, subjectId });

/**
 * Plan the declarations of every spending run. `leadOf` answers the lead of a
 * verify-email serve row (undefined = not resolved yet: the caller resolves first).
 */
export function planRunOutcomes(input: {
  runs: PastRun[];
  pointerAudiencesWithPointer: Set<string>;
  verifyPairs: Map<string, ServeRow | null>;
  leadOf: (serve: ServeRow) => string | null;
  lists: BuiltList[];
}): { planned: PlannedRun[]; notDeclared: NotDeclared[] } {
  const planned: PlannedRun[] = [];
  const notDeclared: NotDeclared[] = [];
  const skip = (r: PastRun, reason: NotDeclaredReason) =>
    notDeclared.push({ runId: r.id, taskName: r.taskName, costCents: r.costCents, reason });
  const plan = (r: PastRun, produced: Occurrence[], consumed: Occurrence[] = []) =>
    planned.push({ runId: r.id, taskName: r.taskName, costCents: r.costCents, produced, consumed });

  const { byRun, shared } = attributeLists(input.runs, input.lists);
  // First completed pointer build per audience wrote the pointer.
  const firstBuild = new Map<string, string>();
  for (const r of [...input.runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
    if (r.taskName === "audience-pointer-build" && r.status === "completed" && r.audienceId && !firstBuild.has(r.audienceId)) {
      firstBuild.set(r.audienceId, r.id);
    }
  }

  for (const r of input.runs) {
    if (!(r.costCents > 0)) continue;
    if (!PRODUCT_TASKS.has(r.taskName)) {
      skip(r, "staff_experiment");
      continue;
    }
    if (r.taskName === "verify-email") {
      const serve = input.verifyPairs.get(r.id) ?? null;
      if (!serve) skip(r, "no_serve_row");
      else if (!serve.verdict || !KEPT_VERDICTS.has(serve.verdict)) skip(r, "verdict_not_kept");
      else {
        const lead = input.leadOf(serve);
        if (!lead) skip(r, "lead_not_found");
        else
          plan(
            r,
            [{ outcomeKey: "email_checked", subjectService: LEAD_SUBJECT_SERVICE, subjectId: lead }],
            [{ outcomeKey: "email_found", subjectService: LEAD_SUBJECT_SERVICE, subjectId: lead }]
          );
      }
      continue;
    }
    if (r.taskName === "audience-target-draft") {
      skip(r, "text_for_lists_built_elsewhere");
      continue;
    }
    if (r.taskName === "audience-split-estimate") {
      skip(r, "estimate_only");
      continue;
    }
    if (r.taskName === "audience-preview-companies") {
      skip(r, "preview_only");
      continue;
    }
    if (r.status !== "completed" && r.status !== "failed") {
      skip(r, "not_completed");
      continue;
    }
    if (r.taskName === "audience-pointer-build") {
      if (r.status !== "completed" || !r.audienceId || !input.pointerAudiencesWithPointer.has(r.audienceId)) skip(r, "no_list_built");
      else if (firstBuild.get(r.audienceId) !== r.id) skip(r, "duplicate_build");
      else plan(r, [audienceBuilt(r.audienceId)]);
      continue;
    }
    const ids = byRun.get(r.id) ?? [];
    if (ids.length > 0) plan(r, ids.sort().map(audienceBuilt));
    else skip(r, shared.has(r.id) ? "list_shared_with_another_run" : "no_list_built");
  }
  return { planned, notDeclared };
}

/** Batches for the backfill door: <= 500 runs and <= 1000 occurrences per call. */
export function batchesOf(planned: PlannedRun[], maxRuns = 500, maxOccurrences = 1000): PlannedRun[][] {
  const out: PlannedRun[][] = [];
  let cur: PlannedRun[] = [];
  let occ = 0;
  for (const p of planned) {
    const n = p.produced.length + p.consumed.length;
    if (cur.length > 0 && (cur.length >= maxRuns || occ + n > maxOccurrences)) {
      out.push(cur);
      cur = [];
      occ = 0;
    }
    cur.push(p);
    occ += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// --- IO -------------------------------------------------------------------------------------

export class BackfillUpstreamError extends Error {
  constructor(public source: string, message: string) {
    super(`[${source}] ${message}`);
    this.name = "BackfillUpstreamError";
  }
}

function env(name: string, source: string): string {
  const v = process.env[name];
  if (!v) throw new BackfillUpstreamError(source, `${name} not set`);
  return v;
}

async function runsGet(path: string, orgId: string): Promise<unknown> {
  const url = env("RUNS_SERVICE_URL", "runs-service");
  const key = env("RUNS_SERVICE_API_KEY", "runs-service");
  const res = await fetch(`${url}${path}`, { headers: { "x-api-key": key, "x-org-id": orgId }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new BackfillUpstreamError("runs-service", `GET ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

interface ApiRun {
  id: string;
  parentRunId: string | null;
  organizationId: string;
  brandIds: string[] | null;
  audienceId: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  actualCostInUsdCents?: string | null;
}

/** Every human-service run of one org, with its billed subtree cost. */
export async function listOrgRuns(orgId: string): Promise<PastRun[]> {
  const out: PastRun[] = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const body = (await runsGet(
      `/v1/runs?serviceName=human-service&include=subtreeCost&limit=${limit}&offset=${offset}`,
      orgId
    )) as { runs?: ApiRun[] };
    if (!Array.isArray(body.runs)) throw new BackfillUpstreamError("runs-service", "GET /v1/runs answered no runs array");
    for (const r of body.runs) {
      if (r.serviceName !== "human-service") continue;
      out.push({
        id: r.id,
        parentRunId: r.parentRunId,
        organizationId: r.organizationId,
        brandIds: r.brandIds ?? [],
        audienceId: r.audienceId,
        taskName: r.taskName,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        costCents: Number(r.actualCostInUsdCents ?? 0),
      });
    }
    if (body.runs.length < limit) break;
  }
  return out;
}

/** lead-service: which lead each (org, brand, email) became. Same door apollo-service uses. */
export async function resolveLeadIds(items: Array<{ orgId: string; brandIds: string[]; email: string }>): Promise<(string | null)[]> {
  const url = env("LEAD_SERVICE_URL", "lead-service");
  const key = env("LEAD_SERVICE_API_KEY", "lead-service");
  const out: (string | null)[] = [];
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500);
    const res = await fetch(`${url}/internal/leads/ids/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ people: chunk }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new BackfillUpstreamError("lead-service", `POST /internal/leads/ids/resolve ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { people?: { leadId?: string | null }[] };
    if (!Array.isArray(body.people) || body.people.length !== chunk.length) {
      throw new BackfillUpstreamError("lead-service", `resolve answered ${Array.isArray(body.people) ? body.people.length : "no"} people for ${chunk.length}`);
    }
    for (const p of body.people) out.push(typeof p.leadId === "string" && p.leadId ? p.leadId : null);
  }
  return out;
}

export interface BatchResult {
  recordedCount: number;
  alreadyRecordedCount: number;
}

async function declareBatch(batch: PlannedRun[]): Promise<BatchResult> {
  const url = env("RUNS_SERVICE_URL", "runs-service");
  const key = env("RUNS_SERVICE_API_KEY", "runs-service");
  const res = await fetch(`${url}/v1/platform-runs/outcomes/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "x-service-name": SUBJECT_SERVICE },
    body: JSON.stringify({
      runs: batch.map((p) => ({
        runId: p.runId,
        ...(p.produced.length ? { produced: p.produced } : {}),
        ...(p.consumed.length ? { consumed: p.consumed } : {}),
        occurredAt: "run_started_at",
      })),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new BackfillUpstreamError("runs-service", `POST /v1/platform-runs/outcomes/batch ${res.status}: ${(await res.text()).slice(0, 1000)}`);
  const body = (await res.json()) as BatchResult;
  return { recordedCount: body.recordedCount, alreadyRecordedCount: body.alreadyRecordedCount };
}

export interface RunOutcomesBackfillResult {
  dryRun: boolean;
  orgs: number;
  runs: number;
  spendingRuns: number;
  spendCents: number;
  declaredRuns: number;
  declaredCents: number;
  occurrences: Record<string, number>;
  notDeclared: Record<NotDeclaredReason, { runs: number; cents: number }>;
  notDeclaredRuns: NotDeclared[];
  recordedCount: number;
  alreadyRecordedCount: number;
}

/** Read every past run, plan, and (unless dryRun) declare. Idempotent: a re-run records nothing new. */
export async function backfillRunOutcomes(opts: { dryRun: boolean }): Promise<RunOutcomesBackfillResult> {
  // Every org that ever held an audience or a serve here: the only orgs our runs belong to.
  const orgRows = await db.execute<{ org_id: string }>(
    sql`SELECT DISTINCT org_id::text AS org_id FROM audiences UNION SELECT DISTINCT org_id::text FROM lead_serves`
  );
  const orgIds = [...orgRows].map((r) => r.org_id);
  const runs: PastRun[] = [];
  for (const orgId of orgIds) runs.push(...(await listOrgRuns(orgId)));

  // verify-email: the serve rows of their parents.
  const verifyRuns = runs.filter((r) => r.taskName === "verify-email" && r.costCents > 0);
  const parents = [...new Set(verifyRuns.map((r) => r.parentRunId).filter((x): x is string => !!x))];
  const serves: ServeRow[] = [];
  for (let i = 0; i < parents.length; i += 1000) {
    const rows = await db
      .select({
        id: leadServes.id,
        runId: leadServes.runId,
        orgId: leadServes.orgId,
        brandId: leadServes.brandId,
        email: leadServes.email,
        verdict: leadServes.emailVerdict,
        servedAt: leadServes.servedAt,
      })
      .from(leadServes)
      .where(and(inArray(leadServes.runId, parents.slice(i, i + 1000)), isNotNull(leadServes.emailVerdict)));
    serves.push(...rows);
  }
  const verifyPairs = pairVerifyRuns(verifyRuns, serves);
  const toResolve = [...verifyPairs.values()].filter((s): s is ServeRow => !!s && !!s.email && !!s.verdict && KEPT_VERDICTS.has(s.verdict));
  const leadIds = await resolveLeadIds(toResolve.map((s) => ({ orgId: s.orgId, brandIds: [s.brandId], email: s.email! })));
  const leadByServe = new Map(toResolve.map((s, i) => [s.id, leadIds[i]]));

  // Pointer builds: which audiences hold a pointer.
  const pointerIds = [...new Set(runs.filter((r) => r.taskName === "audience-pointer-build" && r.audienceId).map((r) => r.audienceId!))];
  const withPointer = new Set<string>();
  for (let i = 0; i < pointerIds.length; i += 1000) {
    const rows = await db
      .select({ id: audiences.id })
      .from(audiences)
      .where(and(inArray(audiences.id, pointerIds.slice(i, i + 1000)), isNotNull(audiences.apolloAudienceId)));
    for (const r of rows) withPointer.add(r.id);
  }

  // Lists created inside a list-building run's window.
  const builders = runs.filter((r) => r.taskName in LIST_TASK_SOURCES && r.costCents > 0 && r.completedAt);
  const lists: BuiltList[] = [];
  if (builders.length > 0) {
    const from = new Date(Math.min(...builders.map((r) => Date.parse(r.startedAt))));
    const to = new Date(Math.max(...builders.map((r) => Date.parse(r.completedAt!))));
    const aud = await db
      .select({ id: audiences.id, orgId: audiences.orgId, brandId: audiences.brandId, source: audiences.source, createdAt: audiences.createdAt })
      .from(audiences)
      .where(and(gte(audiences.createdAt, from), lte(audiences.createdAt, to)));
    for (const a of aud) lists.push({ id: a.id, orgId: a.orgId, brandId: a.brandId, kind: a.source ?? "", createdAt: a.createdAt });
    const src = await db
      .select({ id: audienceSources.id, orgId: audienceSources.orgId, brandId: audienceSources.brandId, list: audienceSources.list, createdAt: audienceSources.createdAt })
      .from(audienceSources)
      .where(and(gte(audienceSources.createdAt, from), lte(audienceSources.createdAt, to)));
    for (const s of src) lists.push({ id: s.id, orgId: s.orgId, brandId: s.brandId, kind: `source:${s.list}`, createdAt: s.createdAt });
  }

  const { planned, notDeclared } = planRunOutcomes({
    runs,
    pointerAudiencesWithPointer: withPointer,
    verifyPairs,
    leadOf: (s) => leadByServe.get(s.id) ?? null,
    lists,
  });

  let recordedCount = 0;
  let alreadyRecordedCount = 0;
  if (!opts.dryRun) {
    for (const batch of batchesOf(planned)) {
      const r = await declareBatch(batch);
      recordedCount += r.recordedCount;
      alreadyRecordedCount += r.alreadyRecordedCount;
      console.log(
        `[human-service] run_outcomes_backfill.batch runs=${batch.length} recorded=${r.recordedCount} already=${r.alreadyRecordedCount}`
      );
    }
  }

  const occurrences: Record<string, number> = {};
  for (const p of planned) for (const o of [...p.produced.map((x) => `produced:${x.outcomeKey}`), ...p.consumed.map((x) => `consumed:${x.outcomeKey}`)]) occurrences[o] = (occurrences[o] ?? 0) + 1;
  const notDeclaredSummary = {} as Record<NotDeclaredReason, { runs: number; cents: number }>;
  for (const n of notDeclared) {
    const s = (notDeclaredSummary[n.reason] ??= { runs: 0, cents: 0 });
    s.runs++;
    s.cents += n.costCents;
  }
  const spending = runs.filter((r) => r.costCents > 0);
  const result: RunOutcomesBackfillResult = {
    dryRun: opts.dryRun,
    orgs: orgIds.length,
    runs: runs.length,
    spendingRuns: spending.length,
    spendCents: spending.reduce((a, r) => a + r.costCents, 0),
    declaredRuns: planned.length,
    declaredCents: planned.reduce((a, p) => a + p.costCents, 0),
    occurrences,
    notDeclared: notDeclaredSummary,
    notDeclaredRuns: notDeclared,
    recordedCount,
    alreadyRecordedCount,
  };
  console.log(
    `[human-service] run_outcomes_backfill.${opts.dryRun ? "dry_run" : "done"} orgs=${result.orgs} runs=${result.runs} spending=${result.spendingRuns} spendCents=${result.spendCents.toFixed(4)} declaredRuns=${result.declaredRuns} declaredCents=${result.declaredCents.toFixed(4)} recorded=${recordedCount} already=${alreadyRecordedCount}`
  );
  return result;
}
