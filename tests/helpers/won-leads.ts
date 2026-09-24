// Shared won-leads-source mock. The serve path reads, per brand, the people that
// brand has already WON from lead-service on every serve that names a brand, and
// fails loud when it cannot — so every suite that exercises a branded serve has to
// answer this call, exactly as prod does.
//
// Default answer is an empty set: the gate is a no-op and those suites stay about
// what they are about.

export const LEAD_TEST_URL = "http://lead:8080";

export function setWonLeadsEnv(): void {
  process.env.LEAD_SERVICE_URL = LEAD_TEST_URL;
  process.env.LEAD_SERVICE_API_KEY = "lead-key";
}

export function isWonLeadsUrl(url: string): boolean {
  return String(url).includes("/won-leads");
}

// The response lead-service would give for this URL, from a map of brandId → won
// addresses. Honours `?email=` (the narrowed read) like the producer does.
export function wonLeadsResponse(
  url: string,
  wonByBrand: Record<string, string[]> = {}
): { brandId: string; emails: string[]; wonLeads: unknown[] } {
  const u = String(url);
  const brandId = decodeURIComponent(u.split("/brands/")[1]?.split("/")[0] ?? "");
  const wanted = new URLSearchParams(u.split("?")[1] ?? "").get("email");
  const all = (wonByBrand[brandId] ?? []).map((e) => e.toLowerCase());
  const emails = wanted
    ? all.includes(wanted.toLowerCase())
      ? [wanted.toLowerCase()]
      : []
    : all;
  return { brandId, emails, wonLeads: [] };
}
