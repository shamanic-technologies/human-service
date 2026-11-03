// treg, consumed directly and METERED like the fleet's other treg calls
// (GMAPS-SOURCE-1103; apollo-service `linkedin-engagement.ts` is the pattern).
//
// One cost name for every treg call: `treg-micro-usd` (quantity = micro-USD).
// Per call: open a child run of the caller's run (once per meter), PROVISION the
// call's ceiling on it, AUTHORIZE it against the org's balance when the key is the
// platform's, EXECUTE with `X-Treg-Route-Max-Cost` = that ceiling, post treg's own
// `X-Treg-Cost-Micro` as an actual cost, cancel the hold. So the cost lands on the
// run that made the call, as a descendant of the serve run that found the business.
//
// Fail loud everywhere: a key we cannot read, a run we cannot open, a hold
// runs-service did not write, a refused authorization, a non-2xx from treg, a 200
// without its charge header: each throws, nothing is served on a guess.

import { randomUUID } from "node:crypto";
import { errorMessage } from "./db-error.js";
import { workflowTrackingToHeaders, type WorkflowTrackingHeaders } from "../middleware/auth.js";
import { fetchWithConnectRetry } from "../services/people-providers.js";

export const TREG_BASE = "https://treg.to/call/";
export const TREG_COST_NAME = "treg-micro-usd";
const CALL_TIMEOUT_MS = 60_000;

export class TregMeterError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = "TregMeterError";
  }
}

/** billing-service refused the spend (balance, or a sales funnel max budget). */
export class TregInsufficientCreditError extends Error {
  constructor(readonly answer: Record<string, unknown>) {
    super(`billing-service refused the treg spend: ${JSON.stringify(answer).slice(0, 300)}`);
    this.name = "TregInsufficientCreditError";
  }
}

export interface MeterIdentity {
  orgId: string;
  userId: string;
  /** The caller's run: the meter's child run hangs under it. */
  runId: string;
  brandIds?: string[];
  campaignId?: string;
  workflowTracking?: WorkflowTrackingHeaders;
}

export interface TregAnswer {
  status: number;
  body: Record<string, unknown> | null;
  chargedMicro: number;
  servedBy: string | null;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new TregMeterError(`${name} is not set`);
  return v;
}

function identityHeaders(identity: MeterIdentity, runId: string): Record<string, string> {
  return {
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": runId,
    ...(identity.brandIds?.length ? { "x-brand-id": identity.brandIds.join(",") } : {}),
    ...(identity.campaignId ? { "x-campaign-id": identity.campaignId } : {}),
    ...workflowTrackingToHeaders(identity.workflowTracking ?? {}),
  };
}

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) throw new TregMeterError(`${what} answered ${res.status}: ${text.slice(0, 300)}`, res.status);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new TregMeterError(`${what} answered a body that is not JSON: ${text.slice(0, 200)}`);
  }
}

async function decryptKey(provider: string, identity: MeterIdentity, callerPath: string): Promise<{ key: string; keySource: "org" | "platform" }> {
  const res = await fetchWithConnectRetry(`${env("KEY_SERVICE_URL")}/keys/${provider}/decrypt`, {
    method: "GET",
    headers: {
      "x-api-key": env("KEY_SERVICE_API_KEY"),
      "x-caller-service": "human",
      "x-caller-method": "POST",
      "x-caller-path": callerPath,
      ...identityHeaders(identity, identity.runId),
    },
  });
  const body = await readJson(res, `key-service ${provider} decrypt`);
  if (typeof body.key !== "string" || (body.keySource !== "org" && body.keySource !== "platform")) {
    throw new TregMeterError(`key-service ${provider} decrypt answered no key / keySource`);
  }
  return { key: body.key, keySource: body.keySource };
}

export class TregMeter {
  private run: Promise<string> | null = null;
  private keys: Promise<{ token: string; org: string; keySource: "org" | "platform" }> | null = null;
  calls = 0;
  chargedMicro = 0;

  constructor(
    private readonly identity: MeterIdentity,
    private readonly taskName: string,
    private readonly callerPath: string
  ) {}

  private resolveKeys() {
    if (!this.keys) {
      this.keys = (async () => {
        const token = await decryptKey("treg", this.identity, this.callerPath);
        const org = await decryptKey("treg-org", this.identity, this.callerPath);
        return { token: token.key, org: org.key, keySource: token.keySource };
      })();
      this.keys.catch(() => {
        this.keys = null;
      });
    }
    return this.keys;
  }

  private ensureRun(): Promise<string> {
    if (!this.run) {
      this.run = (async () => {
        const res = await fetchWithConnectRetry(`${env("RUNS_SERVICE_URL")}/v1/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": env("RUNS_SERVICE_API_KEY"),
            ...identityHeaders(this.identity, this.identity.runId),
          },
          body: JSON.stringify({ serviceName: "human-service", taskName: this.taskName }),
        });
        const body = await readJson(res, "runs-service POST /v1/runs");
        if (typeof body.id !== "string") throw new TregMeterError("runs-service opened no run (no id)");
        return body.id;
      })();
      this.run.catch(() => {
        this.run = null;
      });
    }
    return this.run;
  }

  /** The child run this meter opened (null when nothing was called). */
  async openedRunId(): Promise<string | null> {
    return this.run ? await this.run : null;
  }

  /** Close the child run (when one was opened). A failure is logged, never thrown: the costs are written. */
  async close(status: "completed" | "failed"): Promise<void> {
    if (!this.run) return;
    let runId: string;
    try {
      runId = await this.run;
    } catch {
      return;
    }
    try {
      const res = await fetchWithConnectRetry(`${env("RUNS_SERVICE_URL")}/v1/runs/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-API-Key": env("RUNS_SERVICE_API_KEY"), ...identityHeaders(this.identity, runId) },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) console.error(`[human-service] treg_meter.close_failed run=${runId} status=${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      console.error(`[human-service] treg_meter.close_failed run=${runId}`, err);
    }
  }

  private async addCost(runId: string, item: { quantity: number; status?: "provisioned"; keySource: "org" | "platform" }): Promise<string | null> {
    const res = await fetchWithConnectRetry(`${env("RUNS_SERVICE_URL")}/v1/runs/${runId}/costs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": env("RUNS_SERVICE_API_KEY"), ...identityHeaders(this.identity, runId) },
      body: JSON.stringify({
        items: [
          {
            costName: TREG_COST_NAME,
            costSource: item.keySource,
            quantity: item.quantity,
            ...(item.status ? { status: item.status } : {}),
            idempotencyKey: `human-service:cost:${randomUUID()}`,
          },
        ],
      }),
    });
    const body = await readJson(res, `runs-service POST /v1/runs/${runId}/costs`);
    const costs = body.costs as Array<{ id?: unknown }> | undefined;
    const id = costs?.[0]?.id;
    return typeof id === "string" ? id : null;
  }

  private async cancelHold(runId: string, costId: string): Promise<void> {
    const res = await fetchWithConnectRetry(`${env("RUNS_SERVICE_URL")}/v1/runs/${runId}/costs/${costId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-API-Key": env("RUNS_SERVICE_API_KEY"), ...identityHeaders(this.identity, runId) },
      body: JSON.stringify({ status: "cancelled" }),
    });
    await readJson(res, `runs-service PATCH cost ${costId}`);
  }

  private async authorize(maxMicro: number, description: string): Promise<void> {
    const res = await fetchWithConnectRetry(`${env("BILLING_SERVICE_URL")}/v1/customer_balance/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": env("BILLING_SERVICE_API_KEY"), ...identityHeaders(this.identity, this.identity.runId) },
      body: JSON.stringify({ items: [{ costName: TREG_COST_NAME, quantity: maxMicro }], description }),
    });
    const body = await readJson(res, "billing-service authorize");
    if (body.sufficient !== true) throw new TregInsufficientCreditError(body);
  }

  /**
   * One metered treg call. `maxMicro` is the most it may cost: provisioned,
   * authorized, and sent as the route ceiling, so treg never charges above it.
   */
  async call(endpoint: string, req: { method: "GET" | "POST"; body?: Record<string, unknown>; maxMicro: number }): Promise<TregAnswer> {
    const keys = await this.resolveKeys();
    const runId = await this.ensureRun();
    const holdId = await this.addCost(runId, { quantity: req.maxMicro, status: "provisioned", keySource: keys.keySource });
    if (!holdId) throw new TregMeterError(`runs-service returned no cost id for the ${TREG_COST_NAME} hold`);
    let settled = false;
    try {
      if (keys.keySource === "platform") await this.authorize(req.maxMicro, `${this.taskName}: ${endpoint}`);
      let res: Response;
      try {
        res = await fetch(`${TREG_BASE}${endpoint}`, {
          method: req.method,
          headers: {
            "X-Treg-Token": keys.token,
            "X-Treg-Org": keys.org,
            "Cache-Control": "no-cache",
            "X-Treg-Route-Max-Cost": (req.maxMicro / 1_000_000).toFixed(6),
            ...(req.body ? { "Content-Type": "application/json" } : {}),
          },
          body: req.body ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
      } catch (err) {
        // The call may have reached treg and been billed: keep the hold (never a
        // cost we pretend did not happen); the run reads it as provisioned.
        settled = true;
        throw new TregMeterError(`treg ${endpoint} unreachable: ${errorMessage(err)}`);
      }
      const text = await res.text();
      let body: Record<string, unknown> | null = null;
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        body = { _raw: text.slice(0, 2000) };
      }
      const rawCost = res.headers.get("x-treg-cost-micro");
      let charged = rawCost === null || rawCost.trim() === "" ? null : Number(rawCost);
      if (charged !== null && (!Number.isFinite(charged) || charged < 0)) charged = null;
      if (charged === null) {
        if (res.ok) throw new TregMeterError(`treg ${endpoint} answered ${res.status} without X-Treg-Cost-Micro: the charge cannot be declared`);
        charged = 0; // treg bills nothing for a relayed failure
      }
      if (charged > 0) await this.addCost(runId, { quantity: charged, keySource: keys.keySource });
      this.calls++;
      this.chargedMicro += charged;
      return { status: res.status, body, chargedMicro: charged, servedBy: res.headers.get("x-treg-served-by") };
    } finally {
      if (!settled) await this.cancelHold(runId, holdId);
    }
  }
}
