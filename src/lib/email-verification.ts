// Pre-serve email verification — is this address going to BOUNCE?
//
// An apollo reveal says "verified", and ~7% of those addresses bounced in
// September 2026. Measured on 100 bounced + 100 delivered production addresses,
// the BounceVerify actor (real SMTP + catch-all detection, on bounceverify's own
// backend) separates them:
//
//   verdict     bounced  delivered   ≈ bounce rate inside the verdict
//   invalid        24        3        ~40%
//   unknown        32       15        ~15%
//   catch_all      41       46        ~7%  (the verifier cannot tell on these)
//   valid           3       36        <1%
//
// So this module answers ONE question per revealed address, right after the
// billed reveal and before the person is served: which verdict? The serve path
// (people-providers `finalizeResolved`) decides what to do with it via
// SERVABLE_VERDICTS below.
//
// This is spend human-service makes ITSELF (the platform Apify key pays the
// actor), so it follows the fleet protocol end to end and fails loud at every
// step: create a run → PROVISION the hold → AUTHORIZE against the org balance →
// EXECUTE → ACTUALIZE (+ cancel the hold). A verification that cannot be
// declared is never performed, and a verification that fails never lets the
// person through unverified — the caller surfaces a 502, exactly like the
// teaser screen. (apify-service used to own this route but is not deployed; the
// cost name `apify-bounceverify-email` is the one it declared.)

import type { WorkflowTrackingHeaders } from "../middleware/auth.js";
import { workflowTrackingToHeaders } from "../middleware/auth.js";

export const VERIFY_EMAIL_COST = "apify-bounceverify-email";
const ACTOR = "bounceverify~bounceverify-email-verifier";
// One email measured 2.5-4.3s end to end in production; the actor's own
// server-side timeout is set below this so a stalled SMTP probe ends as
// `unknown` from the actor rather than as a client abort.
const ACTOR_TIMEOUT_S = 60;
const FETCH_TIMEOUT_MS = 90_000;

export type EmailVerdict = "valid" | "invalid" | "catch_all" | "risky" | "unknown";

// The verdicts a person may be SERVED with. Everything else is dropped after
// the reveal (the credit is spent; the send, the generated email and the
// sender reputation are not). THE single policy switch. `risky` (a spam trap,
// or a mailbox the verifier flags as dangerous) is never served; `catch_all`
// is, because the verifier cannot distinguish good from bad on those domains
// and they bounce at the fleet average.
export const SERVABLE_VERDICTS: ReadonlySet<EmailVerdict> = new Set<EmailVerdict>([
  "valid",
  "catch_all",
]);

export function isServableVerdict(v: EmailVerdict): boolean {
  return SERVABLE_VERDICTS.has(v);
}

export class EmailVerificationError extends Error {
  constructor(message: string) {
    super(`[human-service] email verification: ${message}`);
    this.name = "EmailVerificationError";
  }
}

export interface VerificationIdentity {
  orgId: string;
  userId?: string;
  runId?: string;
  workflowTracking?: WorkflowTrackingHeaders;
}

// Map one actor row to a verdict. Same precedence apify-service used: invalid
// is terminal; a catch-all domain cannot confirm the mailbox; a spam trap is
// never "valid".
export function mapVerdict(row: Record<string, unknown> | undefined): EmailVerdict {
  if (!row) return "unknown";
  const raw = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
  if (raw === "invalid") return "invalid";
  if (row.is_catch_all === true) return "catch_all";
  if (row.is_spamtrap === true) return "risky";
  if (raw === "valid") return "valid";
  if (raw === "risky") return "risky";
  return "unknown";
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new EmailVerificationError(`${name} is not configured`);
  return v;
}

async function call(
  label: string,
  url: string,
  init: RequestInit
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new EmailVerificationError(
      `${label} unreachable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new EmailVerificationError(`${label} responded ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new EmailVerificationError(`${label} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function identityHeaders(identity: VerificationIdentity, runId?: string): Record<string, string> {
  return {
    "x-org-id": identity.orgId,
    ...(identity.userId ? { "x-user-id": identity.userId } : {}),
    ...(runId ? { "x-run-id": runId } : {}),
    ...workflowTrackingToHeaders(identity.workflowTracking ?? {}),
  };
}

export async function verifyEmail(
  email: string,
  identity: VerificationIdentity
): Promise<EmailVerdict> {
  if (!identity.userId) {
    throw new EmailVerificationError("x-user-id is required to bill the verification");
  }
  const runsUrl = env("RUNS_SERVICE_URL");
  const runsKey = env("RUNS_SERVICE_API_KEY");
  const billingUrl = env("BILLING_SERVICE_URL");
  const billingKey = env("BILLING_SERVICE_API_KEY");
  const keyUrl = env("KEY_SERVICE_URL");
  const keyKey = env("KEY_SERVICE_API_KEY");

  const runsHeaders = (runId?: string) => ({
    "Content-Type": "application/json",
    "X-API-Key": runsKey,
    ...identityHeaders(identity, runId),
  });

  // Child run of the caller's run, so the spend lands in the caller's tree.
  const run = (await call("runs-service create run", `${runsUrl}/v1/runs`, {
    method: "POST",
    headers: runsHeaders(identity.runId),
    body: JSON.stringify({ serviceName: "human-service", taskName: "verify-email" }),
  })) as { id: string };

  const setRun = (status: "completed" | "failed") =>
    call("runs-service update run", `${runsUrl}/v1/runs/${run.id}`, {
      method: "PATCH",
      headers: runsHeaders(run.id),
      body: JSON.stringify({ status }),
    });

  const addCosts = (items: unknown[]) =>
    call("runs-service add costs", `${runsUrl}/v1/runs/${run.id}/costs`, {
      method: "POST",
      headers: runsHeaders(run.id),
      body: JSON.stringify({ items }),
    }) as Promise<{ costs: Array<{ id: string }> }>;

  const cancelCost = (costId: string) =>
    call("runs-service cancel cost", `${runsUrl}/v1/runs/${run.id}/costs/${costId}`, {
      method: "PATCH",
      headers: runsHeaders(run.id),
      body: JSON.stringify({ status: "cancelled" }),
    });

  let holdIds: string[] = [];
  try {
    // PROVISION — validates the cost name is declarable before any spend.
    const provisioned = await addCosts([
      { costName: VERIFY_EMAIL_COST, costSource: "platform", quantity: 1, status: "provisioned" },
    ]);
    holdIds = provisioned.costs.map((c) => c.id);

    // AUTHORIZE — platform-key spend is paid from the org balance.
    const auth = (await call(
      "billing-service authorize",
      `${billingUrl}/v1/customer_balance/authorize`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": billingKey,
          ...identityHeaders(identity, run.id),
        },
        body: JSON.stringify({
          items: [{ costName: VERIFY_EMAIL_COST, quantity: 1 }],
          description: "human-service pre-serve email verification",
        }),
      }
    )) as { sufficient: boolean; balance_cents?: string; required_cents?: string };
    if (!auth.sufficient) {
      throw new EmailVerificationError(
        `insufficient balance (balance=${auth.balance_cents}¢, required=${auth.required_cents}¢)`
      );
    }

    // EXECUTE.
    const keyRes = (await call(
      "key-service apify platform key",
      `${keyUrl}/keys/platform/apify/decrypt`,
      {
        headers: {
          "X-API-Key": keyKey,
          "X-Caller-Service": "human-service",
          "X-Caller-Method": "POST",
          "X-Caller-Path": "/orgs/audiences/{id}/serve-next",
        },
      }
    )) as { key?: string };
    if (!keyRes.key) throw new EmailVerificationError("key-service returned no apify key");

    const rows = (await call(
      "apify bounceverify",
      `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?timeout=${ACTOR_TIMEOUT_S}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${keyRes.key}` },
        body: JSON.stringify({ emails: [email] }),
      }
    )) as unknown;
    if (!Array.isArray(rows)) {
      throw new EmailVerificationError("apify bounceverify returned a non-array body");
    }
    const target = email.trim().toLowerCase();
    const row = (rows as Array<Record<string, unknown>>).find(
      (r) => typeof r.email === "string" && r.email.trim().toLowerCase() === target
    );
    const verdict = mapVerdict(row);

    // ACTUALIZE — bounceverify charges only DECISIVE results; `unknown` is free.
    if (verdict !== "unknown") {
      await addCosts([
        { costName: VERIFY_EMAIL_COST, costSource: "platform", quantity: 1, status: "actual" },
      ]);
    }
    for (const id of holdIds) await cancelCost(id);
    holdIds = [];
    await setRun("completed");
    return verdict;
  } catch (err) {
    // Release the hold (nothing was bought) and mark the run failed, then
    // surface the ORIGINAL error. A cleanup failure is logged, never swallowed
    // in place of the cause.
    for (const id of holdIds) {
      await cancelCost(id).catch((e) =>
        console.error(`[human-service] verify_email.cancel_hold_failed run=${run.id}`, e)
      );
    }
    await setRun("failed").catch((e) =>
      console.error(`[human-service] verify_email.mark_failed_failed run=${run.id}`, e)
    );
    throw err;
  }
}
