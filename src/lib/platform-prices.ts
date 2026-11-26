// costs-service's platform price of one cost name (`GET /v1/platform-prices/{name}`,
// public, standard list): what one UNIT of a provider's spend costs, in US cents.
// Read by the provider measurement (audience-provider-choice.ts) to put each
// provider's sample on one scale: dollars per company found. Cached 10 min per
// name; a failed read is never cached and never defaulted (fail loud: a choice
// made on an invented price would be a guess dressed as a measurement).

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { cents: number; at: number }>();

export class PlatformPriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformPriceError";
  }
}

export async function platformPriceUsdCents(name: string): Promise<number> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.cents;
  const url = process.env.COSTS_SERVICE_URL;
  if (!url) throw new PlatformPriceError("COSTS_SERVICE_URL is not set");
  let res: Response;
  try {
    res = await fetch(`${url}/v1/platform-prices/${encodeURIComponent(name)}`);
  } catch (err) {
    throw new PlatformPriceError(`costs-service unreachable for price ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new PlatformPriceError(`costs-service price ${name} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const body = (await res.json()) as { pricePerUnitInUsdCents?: unknown };
  const raw = body.pricePerUnitInUsdCents;
  const cents = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(cents) || cents < 0) {
    throw new PlatformPriceError(`costs-service price ${name} carries no usable pricePerUnitInUsdCents (${JSON.stringify(raw)})`);
  }
  cache.set(name, { cents, at: Date.now() });
  return cents;
}

export function clearPlatformPriceCache(): void {
  cache.clear();
}
