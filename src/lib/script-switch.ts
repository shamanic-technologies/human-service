/**
 * FACTORY-P3 next outcomes: what every SERVICE switch of this service shares (the audience split today; the walk keeps
 * its own copy in candidate-walk.ts). workflow-service holds one switch per (outcome, caller service): while it is
 * `switched`, this service runs the stored script (`POST /internal/scripts/run`, service key) in place of its own code
 * and serves the script's doors for the work it has IN FLIGHT (a token handed as material). Read at most once a
 * minute per outcome; unreadable = the last state read; never read = our own code.
 */
import { randomUUID } from "node:crypto";

export const CALLER_SERVICE = "human";
const STATE_TTL_MS = 60_000;
const RUN_TIMEOUT_MS = 600_000;

export interface ScriptSwitch {
  switched: boolean;
  dynasty: string | null;
}

const cached = new Map<string, { state: ScriptSwitch; at: number }>();

/** Test hook. */
export function resetScriptSwitchMemo(): void {
  cached.clear();
}

function workflow(): { base: string; key: string } {
  const base = (process.env.WORKFLOW_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.WORKFLOW_SERVICE_API_KEY ?? "";
  if (!base || !key) throw new Error("[human-service] WORKFLOW_SERVICE_URL and WORKFLOW_SERVICE_API_KEY are required for a script switch");
  return { base, key };
}

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function scriptSwitch(outcome: string, now = Date.now()): Promise<ScriptSwitch> {
  const hit = cached.get(outcome);
  if (hit && now - hit.at < STATE_TTL_MS) return hit.state;
  try {
    const { base, key } = workflow();
    const q = new URLSearchParams({ outcome, callerService: CALLER_SERVICE });
    const res = await fetch(`${base}/internal/scripts/switches/service?${q}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET /internal/scripts/switches/service -> ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { switched?: unknown; dynasty?: unknown };
    const state: ScriptSwitch = body.switched === true && typeof body.dynasty === "string" && body.dynasty ? { switched: true, dynasty: body.dynasty } : { switched: false, dynasty: null };
    cached.set(outcome, { state, at: now });
    return state;
  } catch (error) {
    const kept = hit?.state ?? { switched: false, dynasty: null };
    console.error(`[human-service] ${outcome} switch: state unreadable, keeping ${kept.switched ? `the script ${kept.dynasty}` : "our own code"}: ${messageOf(error)}`);
    cached.set(outcome, { state: kept, at: now });
    return kept;
  }
}

/** One recorded vendor call, in the stored script's words. */
export interface ScriptCall {
  name: string;
  args?: Record<string, unknown>;
  answer: { ok: boolean; data: Record<string, unknown> };
}

export interface InFlight<T> {
  token: string;
  work: T;
  calls: ScriptCall[];
  /** The error our own code would have thrown at that point (re-thrown to the caller). */
  thrown: Error | null;
}

const inFlight = new Map<string, InFlight<unknown>>();

export function registerInFlight<T>(work: T): InFlight<T> {
  const entry: InFlight<T> = { token: randomUUID(), work, calls: [], thrown: null };
  inFlight.set(entry.token, entry as InFlight<unknown>);
  return entry;
}

export function releaseInFlight(entry: InFlight<unknown>): void {
  inFlight.delete(entry.token);
}

export function findInFlight<T>(token: string): InFlight<T> | null {
  return (inFlight.get(token) as InFlight<T> | undefined) ?? null;
}

/** A recorded door call: its answer, or the refusal (kept for the caller, answered 502). */
export async function doorCall<T extends Record<string, unknown>>(entry: InFlight<unknown>, name: string, args: Record<string, unknown>, run: () => Promise<T>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const data = await run();
    entry.calls.push({ name, args, answer: { ok: true, data } });
    return { status: 200, body: data };
  } catch (error) {
    entry.thrown = error instanceof Error ? error : new Error(String(error));
    entry.calls.push({ name, args, answer: { ok: false, data: { error: messageOf(error) } } });
    return { status: 502, body: { error: messageOf(error) } };
  }
}

export class ServiceScriptError extends Error {
  constructor(message: string, readonly runId: string | null, readonly unmade = false) {
    super(message);
  }
}

/**
 * Run a stored script on the caller's run. `billing` = who pays its chat vendors, as our own code did (the doors of
 * this service bill as they always did). Answers the Unit's content, or null (nothing); `unmade` throws with
 * `unmade: true` (no Unit, for a reason the world gave).
 */
export async function runServiceScript(input: {
  outcome: string;
  dynasty: string;
  identity: { orgId: string; userId?: string | null; runId?: string | null; brandIds?: string[]; campaignId?: string | null };
  subject: { service: string; id: string };
  units: Record<string, { content: Record<string, unknown> }>;
  billing?: "org" | "platform";
}): Promise<{ runId: string | null; scriptSlug: string | null; content: Record<string, unknown> | null }> {
  const { base, key } = workflow();
  const id = input.identity;
  if (!id.runId) throw new ServiceScriptError("a stored script needs the caller's run", null);
  const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": key, "x-org-id": id.orgId, "x-run-id": id.runId };
  if (id.userId) headers["x-user-id"] = id.userId;
  if (id.brandIds?.length) headers["x-brand-id"] = id.brandIds.join(",");
  if (id.campaignId) headers["x-campaign-id"] = id.campaignId;
  const res = await fetch(`${base}/internal/scripts/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      outcome: input.outcome,
      dynasty: input.dynasty,
      subject: input.subject,
      units: input.units,
      recordedBy: CALLER_SERVICE,
      ...(input.billing ? { billing: input.billing } : {}),
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
  if (!res.ok) throw new ServiceScriptError(`workflow-service POST /internal/scripts/run -> ${res.status}: ${String(body.error ?? text).slice(0, 400)}`, runId);
  if (body.status === "unmade") throw new ServiceScriptError(String(body.error ?? "unmade"), runId, true);
  if (body.status !== "made" && body.status !== "nothing") throw new ServiceScriptError(`the script answered status ${String(body.status)}`, runId);
  const content = ((body.unit ?? null) as { content?: Record<string, unknown> } | null)?.content ?? null;
  return { runId, scriptSlug: typeof body.scriptSlug === "string" ? body.scriptSlug : null, content };
}
