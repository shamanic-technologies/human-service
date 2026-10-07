// Client for features-service's public sourcing-origins catalogue
// (GET /public/sourcing-origins, no auth): which features-service origin slug
// each human-service audience list kind (channels[].list) is. features-service
// owns that mapping; human-service never re-types it. Cached by the caller
// (src/services/sourcing-origin.ts).
//
// Fail loud: missing env, unreachable, non-2xx or a malformed body throws
// SourcingOriginError. Connect-phase retry only (features-service is a sibling
// container that may be mid-restart).

import { z } from "zod";
import { fetchWithConnectRetry } from "../services/people-providers.js";

export class SourcingOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcingOriginError";
  }
}

const CatalogueSchema = z.object({
  origins: z.array(z.object({ slug: z.string().min(1), audienceLists: z.array(z.string()) })),
});

// list kind -> origin slug.
export async function fetchSourcingOriginsByList(): Promise<Map<string, string>> {
  const base = process.env.FEATURES_SERVICE_URL;
  if (!base) throw new SourcingOriginError("FEATURES_SERVICE_URL is not set: cannot read the sourcing origins");
  const url = `${base}/public/sourcing-origins`;
  let res: Response;
  try {
    res = await fetchWithConnectRetry(url, { method: "GET" });
  } catch (err) {
    throw new SourcingOriginError(`features-service ${url} unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new SourcingOriginError(`features-service ${url} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const parsed = CatalogueSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new SourcingOriginError(`features-service ${url} malformed: ${parsed.error.message}`);
  }
  const byList = new Map<string, string>();
  for (const o of parsed.data.origins) for (const l of o.audienceLists) byList.set(l, o.slug);
  return byList;
}
