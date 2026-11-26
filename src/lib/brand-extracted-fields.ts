// Client for brand-service's stored brand facts (GET /internal/brands/{id}/extracted-fields): what brand-service
// already extracted from the brand's own site. human-service reads `whatTheySell` only, for the relation judge
// (src/services/relation-fit.ts): "is this company in the brand's industry?" needs to know what the brand sells.
// A pure read of stored fields (no extraction, no cost). Absent field = null (never extracted yet), never guessed.
// Fail loud: a non-2xx or malformed body throws BrandServiceError, a missing env BrandConfigError.

import { z } from "zod";
import { errorString } from "./db-error.js";
import { fetchWithConnectRetry } from "../services/people-providers.js";
import { BrandConfigError, BrandServiceError } from "./brand-offers.js";

const ResponseSchema = z.object({
  fields: z.array(z.object({ key: z.string(), value: z.unknown(), campaignId: z.string().nullable().optional() })),
});

export async function getBrandWhatTheySell(brandId: string): Promise<string | null> {
  const url = process.env.BRAND_SERVICE_URL;
  const key = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !key) throw new BrandConfigError("BRAND_SERVICE_URL / BRAND_SERVICE_API_KEY not configured");
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/internal/brands/${encodeURIComponent(brandId)}/extracted-fields`, {
      method: "GET",
      headers: { "x-api-key": key },
    });
  } catch (err) {
    throw new BrandServiceError(0, `brand-service unreachable: ${errorString(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BrandServiceError(res.status, `brand ${brandId} extracted fields: ${text.slice(0, 300)}`);
  }
  const parsed = ResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new BrandServiceError(502, `brand-service returned malformed extracted fields: ${parsed.error.message}`);
  const field = parsed.data.fields.find((f) => f.key === "whatTheySell");
  return typeof field?.value === "string" && field.value.trim() ? field.value.trim() : null;
}
