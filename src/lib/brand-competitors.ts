// Client for brand-service's competitor read: a brand's DIRECT competitors and,
// for each, the LinkedIn company page its OWN website links to. brand-service
// finds them (never the client, never a guess); human-service only reads them to
// build the "engaged with competitor posts" audience
// (src/services/competitor-engagement-audience.ts).
//
// We call the org-scoped DISCOVER route, not the pure read: it computes once when
// nothing is stored (a fraction of a cent of model tokens, billed by brand-service
// to the caller org on a child run of our x-run-id) and returns the stored answer
// at no cost afterwards. The pure read would leave a never-computed brand
// never computed.
//
// Two answers that must never be confused:
//   - `computed` with zero pages: brand-service looked, nothing found.
//   - not computed yet: no answer (422: brand-service knows nothing about the
//     brand yet). The caller retries later, never reads it as "none".
// Any other non-2xx, a network failure or a malformed body throws (fail loud).

import { z } from "zod";
import { downstreamHeaders, fetchWithConnectRetry, type Identity } from "../services/people-providers.js";
import { BrandConfigError, BrandServiceError } from "./brand-offers.js";

// The deployed brand-service contract (BrandCompetitors). Lenient on fields this
// service does not read; strict on the ones the decision rides on.
const BrandCompetitorSchema = z.object({
  name: z.string(),
  domain: z.string(),
  linkedinUrl: z.string().nullable(),
});

const BrandCompetitorsSchema = z.object({
  brandId: z.string(),
  status: z.enum(["not_computed", "computed"]),
  competitors: z.array(BrandCompetitorSchema),
});

export type BrandCompetitor = z.infer<typeof BrandCompetitorSchema>;

export type BrandCompetitorsAnswer =
  | { status: "computed"; competitors: BrandCompetitor[] }
  | { status: "not_computed"; reason: string };

export async function discoverBrandCompetitors(
  brandId: string,
  identity: Identity
): Promise<BrandCompetitorsAnswer> {
  const url = process.env.BRAND_SERVICE_URL;
  const key = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !key) {
    throw new BrandConfigError("BRAND_SERVICE_URL / BRAND_SERVICE_API_KEY not configured");
  }
  const target = `${url}/orgs/brands/${encodeURIComponent(brandId)}/competitors/discover`;
  let res: Response;
  try {
    res = await fetchWithConnectRetry(target, {
      method: "POST",
      headers: downstreamHeaders(key, identity),
      body: JSON.stringify({}),
    });
  } catch (err) {
    throw new BrandServiceError(0, `brand-service unreachable: ${String(err)}`);
  }
  if (res.status === 422) {
    // Nothing is known about the brand yet (its profile is not extracted): not
    // an answer, a "later".
    const text = await res.text().catch(() => "");
    return { status: "not_computed", reason: `brand-service 422: ${text.slice(0, 200)}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BrandServiceError(res.status, `brand-service competitors ${res.status}: ${text.slice(0, 300)}`);
  }
  const parsed = BrandCompetitorsSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    throw new BrandServiceError(
      502,
      `brand-service returned a malformed competitors payload: ${parsed.error.message}`
    );
  }
  if (parsed.data.status === "not_computed") {
    return { status: "not_computed", reason: "brand-service has not computed this brand's competitors yet" };
  }
  return { status: "computed", competitors: parsed.data.competitors };
}
