// Thin client for brand-service GET /internal/personas — the read-only
// enumeration of every brand persona across all brands/orgs, each carrying its
// resolved owning org. Used ONLY by the one-time persona->audience backfill.
//
// brand-service owns the brand->org resolution (org_brands gold table); a
// persona's brand may be claimed by several orgs and brand-service resolves the
// owning org (earliest claim). human-service cannot resolve this itself, so this
// capability is the producer-owned source of truth for the backfill.
//
// Fail loud: a non-2xx throws BrandServiceError -> surfaced as 502 by the route.
// Connect-phase retry only (thrown rejection, never a completed HTTP response)
// for the Neon cold-start edge — same pattern as chat-client / people-providers.

import { z } from "zod";

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

// LOCKED contract with brand-service (GET /internal/personas). Validated here so
// a malformed upstream response fails loud rather than corrupting the backfill.
export const PersonaSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  brandId: z.string().uuid(),
  name: z.string(),
  filters: z.record(z.string(), z.unknown()),
  status: z.enum(["active", "paused", "archived"]),
});

export type Persona = z.infer<typeof PersonaSchema>;

const PersonasResponseSchema = z.object({
  personas: z.array(PersonaSchema),
});

const TRANSIENT_CODES = ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN"];
const RETRY_BACKOFF_MS = [250, 500, 1000];

function isTransientConnectError(err: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (e: unknown): boolean => {
    if (!e || typeof e !== "object" || seen.has(e)) return false;
    seen.add(e);
    const anyE = e as {
      code?: string;
      cause?: unknown;
      errors?: unknown[];
      message?: string;
    };
    if (anyE.code && TRANSIENT_CODES.includes(anyE.code)) return true;
    if (
      typeof anyE.message === "string" &&
      /fetch failed|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(anyE.message)
    )
      return true;
    if (Array.isArray(anyE.errors) && anyE.errors.some(visit)) return true;
    return visit(anyE.cause);
  };
  return visit(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithConnectRetry(
  url: string,
  init: RequestInit
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_BACKOFF_MS.length && isTransientConnectError(err)) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function requireBrand(): { url: string; key: string } {
  const url = process.env.BRAND_SERVICE_URL;
  const key = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !key) {
    throw new BrandConfigError(
      "BRAND_SERVICE_URL / BRAND_SERVICE_API_KEY not configured"
    );
  }
  return { url, key };
}

// Fetch every persona across all brands/orgs from brand-service.
export async function fetchAllPersonas(): Promise<Persona[]> {
  const { url, key } = requireBrand();

  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/internal/personas`, {
      method: "GET",
      headers: { "X-API-Key": key },
    });
  } catch (err) {
    throw new BrandServiceError(0, `brand-service unreachable: ${String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BrandServiceError(res.status, text);
  }

  const data = await res.json().catch(() => null);
  const parsed = PersonasResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new BrandServiceError(
      502,
      `brand-service returned a malformed personas payload: ${parsed.error.message}`
    );
  }
  return parsed.data.personas;
}
