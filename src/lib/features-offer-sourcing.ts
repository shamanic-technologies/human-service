// Client for features-service's per-ORIGIN money of an offer (owner 2026-10-11, Lead Sourcing decides by ROI):
//   GET /offers/{offerId}/sourcing?brandId=&pricing=net   (x-api-key + x-org-id + x-user-id + x-run-id)
// Per origin: the leads it served, the positive replies they gave, what it cost end to end (its sourcing + its
// share of the outreach). features-service OWNS these figures; this service reads them, never recomputes.
//
// Fail loud: missing env/identity, unreachable, non-2xx or a malformed body throws OfferSourcingReadError.

import { errorMessage } from "./db-error.js";
import { z } from "zod";
import { fetchWithConnectRetry } from "../services/people-providers.js";

export class OfferSourcingReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferSourcingReadError";
  }
}

export interface OriginEvidence {
  leadsServed: number;
  positiveReplies: number;
  endToEndCostUsd: number;
}

const OfferSourcingSchema = z.object({
  origins: z.array(
    z.object({
      slug: z.string().nullable(),
      leadsServed: z.number(),
      positiveReplies: z.number(),
      endToEndCostUsd: z.number(),
    })
  ),
});

export async function fetchOfferSourcingEvidence(args: {
  orgId: string;
  brandId: string;
  offerId: string;
  userId: string;
  runId: string;
}): Promise<Map<string, OriginEvidence>> {
  const base = process.env.FEATURES_SERVICE_URL;
  const key = process.env.FEATURES_SERVICE_API_KEY;
  if (!base || !key) throw new OfferSourcingReadError("FEATURES_SERVICE_URL / FEATURES_SERVICE_API_KEY not configured");
  const url = `${base}/offers/${encodeURIComponent(args.offerId)}/sourcing?brandId=${encodeURIComponent(args.brandId)}&pricing=net`;
  let res: Response;
  try {
    res = await fetchWithConnectRetry(url, {
      method: "GET",
      headers: { "x-api-key": key, "x-org-id": args.orgId, "x-user-id": args.userId, "x-run-id": args.runId },
    });
  } catch (err) {
    throw new OfferSourcingReadError(`features-service ${url} unreachable: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    throw new OfferSourcingReadError(`features-service ${url} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const parsed = OfferSourcingSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new OfferSourcingReadError(`features-service ${url} malformed: ${parsed.error.message}`);
  const out = new Map<string, OriginEvidence>();
  for (const o of parsed.data.origins) {
    if (!o.slug) continue;
    out.set(o.slug, { leadsServed: o.leadsServed, positiveReplies: o.positiveReplies, endToEndCostUsd: o.endToEndCostUsd });
  }
  return out;
}
