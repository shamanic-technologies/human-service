// Client for billing-service's payment outlook — the ONE question the audience
// refill needs answered before it spends anything for a client: can billing
// actually charge this org?
//
// billing-service OWNS the answer (`GET /internal/accounts/by-org/{orgId}/payment-outlook`).
// Nothing here re-derives it from balances, cards or budgets: the outlook's
// `state` is billing's own decision, read live.
//
// Owner rule (2026-10-02): never spend for a client who cannot be charged. So
// only `will_charge` (billing expects to present a working card) and
// `charge_due_now` (a charge is due right now) count as chargeable. Every other
// state is NOT: `charge_blocked` (no usable card), `no_autopay` (never charged
// automatically, runs out and stops), `idle` (no live spend), `unknown`
// (spend cannot be measured honestly). A 404 (no billing account) is not
// chargeable either.
//
// Fail loud: a non-2xx other than 404, a network failure or a malformed body
// throws BillingServiceError; a missing env throws BillingConfigError. The
// caller never treats an unreadable outlook as chargeable.

import { z } from "zod";
import { fetchWithConnectRetry } from "../services/people-providers.js";

export class BillingServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "BillingServiceError";
  }
}

export class BillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingConfigError";
  }
}

export const PAYMENT_OUTLOOK_STATES = [
  "will_charge",
  "charge_due_now",
  "charge_blocked",
  "no_autopay",
  "idle",
  "unknown",
] as const;

export type PaymentOutlookState = (typeof PAYMENT_OUTLOOK_STATES)[number];

// Only the fields this service reads. Lenient on everything else so a new
// field on billing's side never breaks the read; strict on `state`, the one
// field the decision rides on (an unknown value fails loud, never chargeable).
const PaymentOutlookSchema = z.object({
  orgId: z.string(),
  state: z.enum(PAYMENT_OUTLOOK_STATES),
  paymentMode: z.string().optional(),
  blockedReason: z.string().nullable().optional(),
});

export type PaymentOutlook = z.infer<typeof PaymentOutlookSchema>;

const CHARGEABLE_STATES: ReadonlySet<PaymentOutlookState> = new Set([
  "will_charge",
  "charge_due_now",
]);

/** Billing can take money from this org. `null` (no billing account) ⟹ no. */
export function canBeCharged(outlook: PaymentOutlook | null): boolean {
  return outlook !== null && CHARGEABLE_STATES.has(outlook.state);
}

function requireBilling(): { url: string; key: string } {
  // Read at call time (not boot), same convention as every sibling client.
  const url = process.env.BILLING_SERVICE_URL;
  const key = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !key) {
    throw new BillingConfigError(
      "BILLING_SERVICE_URL / BILLING_SERVICE_API_KEY not configured"
    );
  }
  return { url, key };
}

/**
 * Read the org's payment outlook. Returns null when billing holds no account
 * for the org (404) — a legitimate answer meaning "nothing can be charged".
 */
export async function getPaymentOutlook(orgId: string): Promise<PaymentOutlook | null> {
  const { url, key } = requireBilling();
  const target = `${url}/internal/accounts/by-org/${encodeURIComponent(orgId)}/payment-outlook`;

  let res: Response;
  try {
    res = await fetchWithConnectRetry(target, {
      method: "GET",
      headers: { "x-api-key": key },
    });
  } catch (err) {
    throw new BillingServiceError(0, `billing-service unreachable: ${String(err)}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BillingServiceError(res.status, text);
  }
  const data = await res.json().catch(() => null);
  const parsed = PaymentOutlookSchema.safeParse(data);
  if (!parsed.success) {
    throw new BillingServiceError(
      502,
      `billing-service returned a malformed payment outlook: ${parsed.error.message}`
    );
  }
  return parsed.data;
}
