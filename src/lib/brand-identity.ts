// Client for brand-service's single-brand read (GET /internal/brands/{id}) —
// what human-service needs to know WHICH COMPANY a brand is, so it never
// proposes or serves that company's own staff as prospects
// (src/services/own-company.ts).
//
// brand-service owns the brand entity: its normalized domain, its display name,
// and (org-scoped, via x-org-id) the sales rep's email, whose domain is the
// brand's work-email domain when it differs from the website's.
//
// Fail loud: a non-2xx (404 included) throws BrandServiceError, a missing env
// throws BrandConfigError — the same errors as the offers client, which the
// routes already map to 502. Connect-phase retry only.

import { z } from "zod";
import { fetchWithConnectRetry } from "../services/people-providers.js";
import { BrandConfigError, BrandServiceError } from "./brand-offers.js";

const BrandIdentitySchema = z.object({
  id: z.string(),
  domain: z.string().nullable(),
  url: z.string().nullable(),
  name: z.string(),
  salesRepEmail: z.string().nullable().optional(),
});

export type BrandIdentity = z.infer<typeof BrandIdentitySchema>;

const ResponseSchema = z.object({ brand: BrandIdentitySchema });

export async function getBrandIdentity(
  brandId: string,
  orgId: string
): Promise<BrandIdentity> {
  const url = process.env.BRAND_SERVICE_URL;
  const key = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !key) {
    throw new BrandConfigError(
      "BRAND_SERVICE_URL / BRAND_SERVICE_API_KEY not configured"
    );
  }
  const target = `${url}/internal/brands/${encodeURIComponent(brandId)}`;

  let res: Response;
  try {
    res = await fetchWithConnectRetry(target, {
      method: "GET",
      headers: { "x-api-key": key, "x-org-id": orgId },
    });
  } catch (err) {
    throw new BrandServiceError(0, `brand-service unreachable: ${String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BrandServiceError(res.status, `brand ${brandId}: ${text}`);
  }
  const parsed = ResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    throw new BrandServiceError(
      502,
      `brand-service returned a malformed brand payload: ${parsed.error.message}`
    );
  }
  return parsed.data.brand;
}
