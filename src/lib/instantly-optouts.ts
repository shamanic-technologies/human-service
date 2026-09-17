// Client for instantly-service's recorded opt-outs — the org's consent log.
//
// instantly-service OWNS this record: it performed the terminal action (the
// send), it holds who said it, when, through which channel, and the withdrawal
// log. Nothing here reconstructs the fact from anything else — no bounce, no
// negative reply, no silence. We read the statements it recorded and honour them.
//
// Two reads, mirroring the two shapes the serve path needs:
//
//   listStandingOptOutEmails — the org's whole standing set, for the gates that
//                              must exclude BEFORE an email is in hand (the free
//                              apollo teaser, the apify exclude push-down).
//   isEmailOptedOut          — one exact address, for the post-reveal block.
//
// Fail loud, always: a gate that cannot read its own input must not wave people
// through. A non-2xx / network error throws OptOutSourceError and a missing env
// throws OptOutConfigError; both surface as 502 at the route.

import {
  downstreamHeaders,
  fetchWithConnectRetry,
  type Identity,
} from "../services/people-providers.js";

export class OptOutSourceError extends Error {
  constructor(public status: number, public body: string) {
    super(
      `[instantly] opt-out source responded ${status}: ${body.slice(0, 200)}`
    );
    this.name = "OptOutSourceError";
  }
}

export class OptOutConfigError extends Error {
  constructor() {
    super("[instantly] service URL / API key not configured");
    this.name = "OptOutConfigError";
  }
}

function requireInstantly(): { url: string; key: string } {
  // Read at call time (not boot) so a missing var fails the request loudly
  // rather than crash-looping boot — same convention as apollo/apify/crm.
  const url = process.env.INSTANTLY_SERVICE_URL;
  const key = process.env.INSTANTLY_SERVICE_API_KEY;
  if (!url || !key) throw new OptOutConfigError();
  return { url, key };
}

// instantly-service's deployed cap on GET /orgs/opt-outs (`limit` max 500, no
// cursor). Asking for exactly the cap is what lets us DETECT a truncated read.
const OPT_OUT_PAGE_LIMIT = 500;

interface OptOutRow {
  email: string;
  // Non-null ⟹ the record was taken back and no longer stands. `standing_only`
  // already excludes those; we re-check because a withdrawn opt-out MUST put the
  // person back in the pool, and that is the one direction worth being explicit
  // about rather than trusting a query param.
  withdrawnAt: string | null;
}

async function getOptOuts(
  identity: Identity,
  query: string
): Promise<OptOutRow[]> {
  const { url, key } = requireInstantly();
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/orgs/opt-outs?${query}`, {
      method: "GET",
      headers: downstreamHeaders(key, identity),
    });
  } catch (err) {
    throw new OptOutSourceError(0, String(err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OptOutSourceError(res.status, text);
  }
  const data = (await res.json()) as { optOuts?: OptOutRow[] };
  const rows = Array.isArray(data.optOuts) ? data.optOuts : [];
  return rows.filter((r) => !r.withdrawnAt);
}

// Every address in the org that currently carries a standing opt-out, lowercased
// and trimmed (the same normalization instantly-service compares under, and the
// same one this service already applies to an email).
//
// TRUNCATION IS AN ERROR, not a shorter answer. The endpoint caps at 500 rows
// with no cursor, so a full page means there may be opt-outs we did not see —
// and a gate silently missing entries emits somebody who asked us to stop. We
// refuse instead. (28 standing across the whole fleet at the time this shipped;
// if an org ever reaches 500, instantly-service needs a cursor, not a bigger cap.)
export async function listStandingOptOutEmails(
  identity: Identity
): Promise<string[]> {
  const rows = await getOptOuts(
    identity,
    `standing_only=true&limit=${OPT_OUT_PAGE_LIMIT}`
  );
  if (rows.length >= OPT_OUT_PAGE_LIMIT) {
    throw new OptOutSourceError(
      0,
      `opt-out list hit the ${OPT_OUT_PAGE_LIMIT}-row cap for org ${identity.orgId} — the standing set cannot be read in full, so the serve gate cannot be trusted`
    );
  }
  return [
    ...new Set(
      rows
        .map((r) => (r.email ?? "").trim().toLowerCase())
        .filter((e) => e.length > 0)
    ),
  ];
}

// Does this exact address carry a standing opt-out? One indexed lookup at the
// owner, no list, no cap — used post-reveal where the email IS in hand.
export async function isEmailOptedOut(
  identity: Identity,
  email: string | null | undefined
): Promise<boolean> {
  const normalized = (email ?? "").trim().toLowerCase();
  if (normalized.length === 0) return false;
  const rows = await getOptOuts(
    identity,
    `standing_only=true&limit=1&email=${encodeURIComponent(normalized)}`
  );
  return rows.length > 0;
}
