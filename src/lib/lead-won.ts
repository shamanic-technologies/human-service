// Client for lead-service's won leads — the people a brand has already WON (a
// paying client).
//
// lead-service OWNS this fact: "won" is a live, attributed `sale` on its outcome
// ledger, whoever observed it (a person's statement, the brand's tracker, the
// customer's CRM). Nothing here reconstructs it from anything else and nothing
// here stores a copy: the set is read live on every serve, so a sale withdrawn
// upstream puts the person back in the pool on the very next one.
//
// Two reads, mirroring the opt-out client beside it:
//
//   listWonEmails — the brand's whole won set, for the gates that must exclude
//                   BEFORE an email is in hand (the free apollo teaser, the apify
//                   exclude push-down, serve-next's pop-time check).
//   isEmailWon    — one exact address, for the post-reveal block.
//
// Scope is the (org, brand) pair: a person won by brand A stays servable for
// brand B of the same org. Fail loud, always: lead-service answers a failed read
// with a 500, never an empty set, and we keep that posture — a non-2xx / network
// error / malformed body throws WonLeadsSourceError and a missing env throws
// WonLeadsConfigError; both surface as 502 at the route.

import {
  downstreamHeaders,
  fetchWithConnectRetry,
  type Identity,
} from "../services/people-providers.js";

export class WonLeadsSourceError extends Error {
  constructor(public status: number, public body: string) {
    super(`[lead] won-leads source responded ${status}: ${body.slice(0, 200)}`);
    this.name = "WonLeadsSourceError";
  }
}

export class WonLeadsConfigError extends Error {
  constructor() {
    super("[lead] service URL / API key not configured");
    this.name = "WonLeadsConfigError";
  }
}

function requireLead(): { url: string; key: string } {
  // Read at call time (not boot) so a missing var fails the request loudly
  // rather than crash-looping boot — same convention as apollo/apify/instantly.
  const url = process.env.LEAD_SERVICE_URL;
  const key = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !key) throw new WonLeadsConfigError();
  return { url, key };
}

async function getWonEmails(
  identity: Identity,
  brandId: string,
  email: string | null
): Promise<string[]> {
  const { url, key } = requireLead();
  const query = email === null ? "" : `?email=${encodeURIComponent(email)}`;
  let res: Response;
  try {
    res = await fetchWithConnectRetry(
      `${url}/orgs/brands/${encodeURIComponent(brandId)}/won-leads${query}`,
      { method: "GET", headers: downstreamHeaders(key, identity) }
    );
  } catch (err) {
    throw new WonLeadsSourceError(0, String(err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new WonLeadsSourceError(res.status, text);
  }
  const data = (await res.json()) as { emails?: unknown };
  // `emails` is the whole answer. A body without it is not "nobody won" — it is
  // a contract we cannot read, and reading it as empty would wave people through.
  if (!Array.isArray(data.emails)) {
    throw new WonLeadsSourceError(
      res.status,
      `won-leads body carries no emails array for brand ${brandId}`
    );
  }
  return [
    ...new Set(
      data.emails
        .filter((e): e is string => typeof e === "string")
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0)
    ),
  ];
}

// Every address the brand has won, lowercased + trimmed (the normalization
// lead-service answers under and the one this service applies to an email).
export async function listWonEmails(
  identity: Identity,
  brandId: string
): Promise<string[]> {
  return getWonEmails(identity, brandId, null);
}

// Is this exact address a person the brand has won? Same query narrowed at the
// owner, so the one-address check cannot disagree with the set.
export async function isEmailWon(
  identity: Identity,
  brandId: string,
  email: string | null | undefined
): Promise<boolean> {
  const normalized = (email ?? "").trim().toLowerCase();
  if (normalized.length === 0) return false;
  const emails = await getWonEmails(identity, brandId, normalized);
  return emails.includes(normalized);
}
