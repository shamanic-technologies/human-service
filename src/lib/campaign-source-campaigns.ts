// Client for campaign-service's SOURCE CAMPAIGNS of an offer (owner 2026-10-07):
//   GET /internal/offers/{offerId}/source-campaigns?brandId=   (x-api-key + x-org-id)
// One entry per sourcing origin of the offer: `campaignId` null = no campaign yet
// (the origin is OFF), `running` = the campaign is ongoing (ON). campaign-service
// OWNS on/off; this service only reads it and keeps the offer's audiences in step
// (src/services/source-campaigns.ts).
//
// Fail loud: missing env, unreachable, non-2xx or a malformed body throws
// CampaignServiceError. Connect-phase retry only (a sibling container that may be
// mid-restart).

import { z } from "zod";
import { fetchWithConnectRetry } from "../services/people-providers.js";

export class CampaignServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "CampaignServiceError";
  }
}

// Only the fields read here; lenient on the rest so a new field never breaks it.
const OfferSourceCampaignSchema = z.object({
  featureSlug: z.string().min(1),
  campaignId: z.string().nullable(),
  status: z.string().nullable(),
  running: z.boolean(),
});

const OfferSourceCampaignsSchema = z.object({
  sourceCampaigns: z.array(OfferSourceCampaignSchema),
});

export type OfferSourceCampaign = z.infer<typeof OfferSourceCampaignSchema>;

export async function fetchOfferSourceCampaigns(scope: {
  orgId: string;
  brandId: string;
  offerId: string;
}): Promise<OfferSourceCampaign[]> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const key = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !key) {
    throw new CampaignServiceError(0, "CAMPAIGN_SERVICE_URL / CAMPAIGN_SERVICE_API_KEY not configured");
  }
  const target =
    `${url}/internal/offers/${encodeURIComponent(scope.offerId)}/source-campaigns` +
    `?brandId=${encodeURIComponent(scope.brandId)}`;
  let res: Response;
  try {
    res = await fetchWithConnectRetry(target, {
      method: "GET",
      headers: { "x-api-key": key, "x-org-id": scope.orgId },
    });
  } catch (err) {
    throw new CampaignServiceError(0, `campaign-service unreachable: ${String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CampaignServiceError(res.status, `campaign-service ${target} answered ${res.status}: ${text.slice(0, 300)}`);
  }
  const parsed = OfferSourceCampaignsSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    throw new CampaignServiceError(502, `campaign-service source campaigns malformed: ${parsed.error.message}`);
  }
  return parsed.data.sourceCampaigns;
}
