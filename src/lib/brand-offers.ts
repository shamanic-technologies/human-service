// Client for brand-service's internal offer read — the ONE capability
// human-service needs from brand-service to attribute an audience to the offer
// it was assembled for.
//
// brand-service owns the offer entity. An offer is per (org, brand), NOT per
// brand: brand identity is shared across orgs by domain, so several orgs claim
// one brand and each holds its own offer row for it. That is why the org is
// passed explicitly on every call rather than left to brand-service's
// single-claimer fallback — a brand claimed by several orgs would otherwise be
// rejected 400 ORG_REQUIRED, and a wrong org would attribute an audience to
// another company's offer.
//
// Read-only. Used ONLY by the one-time offer-attribution repair
// (POST /internal/backfill-audience-offers) — the live audience routes still
// store `offer_id` verbatim with no cross-service lookup, exactly like
// `brand_id`.
//
// Fail loud: a non-2xx throws BrandServiceError (the caller decides whether that
// is per-pair skippable or fatal); a missing env throws BrandConfigError.
// Connect-phase retry only (thrown rejection, never a completed HTTP response) —
// brand-service is a sibling container that may be mid-restart.

import { z } from "zod";
import { fetchWithConnectRetry } from "../services/people-providers.js";

export class BrandServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "BrandServiceError";
  }
}

export class BrandConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandConfigError";
  }
}

// The deployed brand-service contract (GET /internal/brands/{brandId}/offers).
// Validated here so a malformed upstream payload fails loud rather than silently
// attributing audiences to nothing.
const BrandOfferSchema = z.object({
  offerId: z.string().uuid(),
  brandId: z.string().uuid(),
  name: z.string(),
});

export type BrandOffer = z.infer<typeof BrandOfferSchema>;

const OffersResponseSchema = z.object({
  offers: z.array(BrandOfferSchema),
});

function requireBrand(): { url: string; key: string } {
  // Read at call time (not boot) so a missing var fails the request loudly
  // rather than crash-looping boot — same convention as apollo/apify/crm.
  const url = process.env.BRAND_SERVICE_URL;
  const key = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !key) {
    throw new BrandConfigError(
      "BRAND_SERVICE_URL / BRAND_SERVICE_API_KEY not configured"
    );
  }
  return { url, key };
}

// List the offers the given org holds under the given brand. An unclaimed brand
// (or an org that holds no offer for it) answers with an empty list — that is a
// legitimate answer, not an error, and the caller leaves such audiences alone.
export async function listBrandOffers(
  brandId: string,
  orgId: string
): Promise<BrandOffer[]> {
  const { url, key } = requireBrand();
  const target = `${url}/internal/brands/${encodeURIComponent(brandId)}/offers`;

  let res: Response;
  try {
    res = await fetchWithConnectRetry(target, {
      method: "GET",
      headers: {
        "x-api-key": key,
        "x-org-id": orgId,
      },
    });
  } catch (err) {
    throw new BrandServiceError(0, `brand-service unreachable: ${String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BrandServiceError(res.status, text);
  }

  const data = await res.json().catch(() => null);
  const parsed = OffersResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new BrandServiceError(
      502,
      `brand-service returned a malformed offers payload: ${parsed.error.message}`
    );
  }
  return parsed.data.offers;
}
