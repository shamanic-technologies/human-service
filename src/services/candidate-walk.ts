/**
 * FACTORY-P3 next outcomes (lead_found): the candidates WALK of an apollo audience as a stored script
 * (workflow-service `lead_found/<dynasty>`, proven 100 % on recorded walks), while workflow-service says the outcome is
 * switched for this service (`GET /internal/scripts/switches/service?outcome=lead_found&callerService=human`, read at
 * most once a minute; unreadable = the last state, never read = our own code).
 *
 * ONE script run per walk (one `candidates/next`), never one per person. The script asks this service for a PAGE of
 * teasers at a time with the FACTS each free rule reads (`human.walk.page`: the brand's last serve of the person, a
 * standing opt-out or win, the employer's name, a bounce, a rejection for this audience; the walk's `now`), decides
 * every teaser's verdict itself (re-contact window, own company, the rules' order), and hands the verdicts back
 * (`human.walk.decide`): this service applies them in order exactly as its own walk does (a taken person is tagged as
 * found, the first passing one is offered once per (audience, person), a teaser after it goes back to the buffer where
 * it was). The search, the buffer refill, the time budget, the re-offers before the walk stay here.
 *
 * Every walk is recordable for the script's proof: our own walk records a sample of its walks in the script's words
 * (one teaser per page), the script's walks are all recorded (`candidate_walks`).
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, max, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audienceScreenedOut, brandSuppressions, candidateWalks } from "../db/schema.js";
import { normalizeLinkedinUrl } from "./suppression.js";
import { matchesOptOut, type OptOutExclusions } from "./opt-outs.js";
import { filterBounced } from "./bounces.js";
import type { Identity } from "./people-providers.js";
import type { BufferedTeaser } from "./teaser-buffer.js";

export const LEAD_FOUND_OUTCOME = "lead_found";
export const CALLER_SERVICE = "human";
const STATE_TTL_MS = 60_000;
const RUN_TIMEOUT_MS = 600_000;
/** Teasers per page of the script's walk (a walk stays far under the script's 500 calls). */
export const SCRIPT_PAGE_SIZE = 20;
/** Share of OUR OWN walks recorded for the script's proof (each costs the facts' reads once more). */
export const SERVICE_RECORD_SHARE = 0.2;

/** The first free rule a teaser fails, in the order our walk runs them, or `offer`. */
export type WalkVerdict = "taken" | "opted_out" | "own_company" | "bounced" | "rejected" | "offer";

/** What each free rule reads about one teaser (`ref` = its provider person id). */
export interface TeaserFacts {
  ref: string;
  /** The brand's latest serve (or send) of this person, by provider id or LinkedIn URL, any window. */
  lastServedAt: string | null;
  optedOut: boolean;
  organizationName: string | null;
  bounced: boolean;
  rejected: boolean;
}

export interface DecisionCall {
  name: string;
  args?: Record<string, unknown>;
  answer: { ok: boolean; data: Record<string, unknown> };
}

/** The walk's clock, as the database reads it (the re-contact window is `now() - interval` there). */
export async function walkNow(): Promise<string> {
  const rows = await db.execute(sql`SELECT now()::timestamptz AS now`);
  const now = (rows as unknown as Array<{ now: Date | string }>)[0]?.now ?? (rows as unknown as { rows: Array<{ now: Date | string }> }).rows?.[0]?.now;
  return new Date(now as string).toISOString();
}

/** The facts of a page of teasers: one read per rule for the whole page. */
export async function teaserFacts(
  identity: Identity,
  audienceId: string,
  teasers: BufferedTeaser[],
  exclusions: OptOutExclusions
): Promise<TeaserFacts[]> {
  if (teasers.length === 0) return [];
  const brandIds = [...new Set(identity.brandIds ?? [])];
  const norms = teasers.map((t) => normalizeLinkedinUrl(t.linkedinUrl));
  const ids = teasers.map((t) => t.providerPersonId).filter((x): x is string => !!x);
  const lns = norms.filter((x): x is string => x !== null);

  const served = new Map<string, Date>();
  if (brandIds.length > 0 && (ids.length > 0 || lns.length > 0)) {
    const conds = [];
    if (lns.length > 0) conds.push(inArray(brandSuppressions.linkedinUrlNorm, lns));
    if (ids.length > 0) conds.push(inArray(brandSuppressions.providerPersonId, ids));
    const rows = await db
      .select({ ln: brandSuppressions.linkedinUrlNorm, pid: brandSuppressions.providerPersonId, at: max(brandSuppressions.lastServedAt) })
      .from(brandSuppressions)
      .where(and(eq(brandSuppressions.orgId, identity.orgId), inArray(brandSuppressions.brandId, brandIds), or(...conds)))
      .groupBy(brandSuppressions.linkedinUrlNorm, brandSuppressions.providerPersonId);
    for (const r of rows) {
      const at = r.at ? new Date(r.at as unknown as string) : null;
      if (!at) continue;
      for (const k of [r.ln ? `ln:${r.ln}` : null, r.pid ? `id:${r.pid}` : null]) {
        if (k && (!served.has(k) || served.get(k)! < at)) served.set(k, at);
      }
    }
  }

  const reachable = new Set(
    (await filterBounced(identity, teasers.map((t) => ({ linkedinUrl: t.linkedinUrl, providerPersonId: t.providerPersonId })))).map((t) => t.providerPersonId)
  );
  const rejected = new Set(
    (
      await db
        .select({ pid: audienceScreenedOut.providerPersonId })
        .from(audienceScreenedOut)
        .where(and(eq(audienceScreenedOut.audienceId, audienceId), inArray(audienceScreenedOut.providerPersonId, ids.length > 0 ? ids : [""])))
    ).map((r) => r.pid)
  );

  return teasers.map((t, i) => {
    const ln = norms[i];
    const a = ln ? served.get(`ln:${ln}`) : undefined;
    const b = t.providerPersonId ? served.get(`id:${t.providerPersonId}`) : undefined;
    const last = a && b ? (a > b ? a : b) : (a ?? b ?? null);
    return {
      ref: t.providerPersonId,
      lastServedAt: last ? last.toISOString() : null,
      optedOut: matchesOptOut(exclusions, { linkedinUrl: t.linkedinUrl, providerPersonId: t.providerPersonId }),
      organizationName: t.teaser?.organizationName ?? null,
      bounced: !reachable.has(t.providerPersonId),
      rejected: rejected.has(t.providerPersonId),
    };
  });
}

// ─── The switch ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WalkScriptSwitch {
  switched: boolean;
  dynasty: string | null;
}

let cached: { state: WalkScriptSwitch; at: number } | null = null;

/** Test hook. */
export function resetWalkScriptSwitchMemo(): void {
  cached = null;
}

function workflow(): { base: string; key: string } {
  const base = (process.env.WORKFLOW_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.WORKFLOW_SERVICE_API_KEY ?? "";
  if (!base || !key) throw new Error("[human-service] WORKFLOW_SERVICE_URL and WORKFLOW_SERVICE_API_KEY are required for the walk switch");
  return { base, key };
}

export async function walkScriptSwitch(now = Date.now()): Promise<WalkScriptSwitch> {
  if (cached && now - cached.at < STATE_TTL_MS) return cached.state;
  try {
    const { base, key } = workflow();
    const q = new URLSearchParams({ outcome: LEAD_FOUND_OUTCOME, callerService: CALLER_SERVICE });
    const res = await fetch(`${base}/internal/scripts/switches/service?${q}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET /internal/scripts/switches/service -> ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { switched?: unknown; dynasty?: unknown };
    const state: WalkScriptSwitch = body.switched === true && typeof body.dynasty === "string" && body.dynasty ? { switched: true, dynasty: body.dynasty } : { switched: false, dynasty: null };
    cached = { state, at: now };
    return state;
  } catch (error) {
    const kept = cached?.state ?? { switched: false, dynasty: null };
    console.error(`[human-service] walk switch: state unreadable, keeping ${kept.switched ? `the script ${kept.dynasty}` : "our own code"}: ${errorMessageOf(error)}`);
    cached = { state: kept, at: now };
    return kept;
  }
}

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Walks in flight (the doors serve only these) ─────────────────────────────────────────────────────────────────

export interface InFlightWalk<W> {
  token: string;
  walk: W;
  calls: DecisionCall[];
  thrown: Error | null;
}

const inFlight = new Map<string, InFlightWalk<unknown>>();

export function registerWalk<W>(walk: W): InFlightWalk<W> {
  const entry: InFlightWalk<W> = { token: randomUUID(), walk, calls: [], thrown: null };
  inFlight.set(entry.token, entry as InFlightWalk<unknown>);
  return entry;
}

export function releaseWalk(entry: InFlightWalk<unknown>): void {
  inFlight.delete(entry.token);
}

export function findWalk<W>(token: string): InFlightWalk<W> | null {
  return (inFlight.get(token) as InFlightWalk<W> | undefined) ?? null;
}

export class WalkScriptError extends Error {
  constructor(message: string, readonly runId: string | null) {
    super(message);
  }
}

/**
 * Run the stored walk on the serve's run. The walk's token rides the material (the doors find the walk by it); the
 * script answers the candidate it had offered, or nothing (pending / exhausted, read from the walk itself).
 */
export async function walkWithScript(input: {
  dynasty: string;
  identity: Identity;
  token: string;
  ownNames: string[];
  window: string;
  pageSize: number;
}): Promise<{ runId: string | null; scriptSlug: string | null; candidateId: string | null }> {
  const { base, key: apiKey } = workflow();
  const id = input.identity;
  if (!id.runId) throw new WalkScriptError("a stored walk needs the serve's run", null);
  const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": apiKey, "x-org-id": id.orgId, "x-run-id": id.runId };
  if (id.userId) headers["x-user-id"] = id.userId;
  if (id.brandIds?.length) headers["x-brand-id"] = id.brandIds.join(",");
  if (id.campaignId) headers["x-campaign-id"] = id.campaignId;
  const res = await fetch(`${base}/internal/scripts/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      outcome: LEAD_FOUND_OUTCOME,
      dynasty: input.dynasty,
      subject: { service: "human", id: input.token },
      units: { audience_built: { content: { walk: input.token, ownNames: input.ownNames, window: input.window, pageSize: input.pageSize } } },
      recordedBy: CALLER_SERVICE,
    }),
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Named below by status.
  }
  const details = (res.ok ? body : ((body.details ?? {}) as Record<string, unknown>)) as Record<string, unknown>;
  const runId = typeof details.runId === "string" ? details.runId : null;
  if (!res.ok) throw new WalkScriptError(`workflow-service POST /internal/scripts/run -> ${res.status}: ${String(body.error ?? text).slice(0, 400)}`, runId);
  const content = ((body.unit ?? null) as { content?: Record<string, unknown> } | null)?.content ?? null;
  const candidateId = typeof content?.candidateId === "string" ? content.candidateId : null;
  if (body.status !== "made" && body.status !== "nothing") throw new WalkScriptError(`the walk answered status ${String(body.status)}`, runId);
  return { runId, scriptSlug: typeof body.scriptSlug === "string" ? body.scriptSlug : null, candidateId };
}

/** Fail-soft record of one walk (personal data: never logged). */
export async function recordWalk(r: {
  orgId: string;
  audienceId: string;
  serveRunId: string | null;
  runId: string | null;
  path: "service" | "script";
  units: Record<string, unknown>;
  calls: DecisionCall[];
  candidateId: string | null;
  status: string;
  error: string | null;
}): Promise<void> {
  try {
    await db.insert(candidateWalks).values({
      orgId: r.orgId,
      audienceId: r.audienceId,
      serveRunId: r.serveRunId,
      runId: r.runId,
      path: r.path,
      units: r.units,
      calls: r.calls,
      candidateId: r.candidateId,
      status: r.status,
      error: r.error ? r.error.slice(0, 1000) : null,
    });
  } catch (error) {
    console.error(`[human-service] candidate walk NOT recorded (the serve stands): ${errorMessageOf(error)}`);
  }
}

