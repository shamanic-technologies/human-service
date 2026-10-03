// Client for instantly-service's bounce record — "our own send to this address
// bounced", fleet-wide.
//
// instantly-service OWNS this record: it performed the terminal action (the
// send) and recorded the permanent failure (`POST /internal/bounced-emails`).
// Nothing here reconstructs a bounce from anything else and nothing here stores
// a copy: the answer is read live on every serve.
//
// Unlike the opt-out client beside it, this read carries NO org scope. A bounce
// is a fact about the ADDRESS (the mailbox does not exist or refuses mail),
// whoever writes to it; an opt-out is consent given to one sender. So an address
// that bounced for org A is unreachable for org B too (human-service#73).
//
// Hard vs soft: instantly-service records only PERMANENT failures as a bounce
// (temporary delivery delays are never promoted, and the ones that once were
// were retracted), so every address it returns is a hard bounce.
//
// Fail loud, always: a non-2xx / network error / malformed body throws
// BounceSourceError and a missing env throws BounceConfigError; both surface as
// 502 at the route, exactly like an unreadable opt-out log.

import {
  downstreamHeaders,
  fetchWithConnectRetry,
  type Identity,
} from "../services/people-providers.js";

export class BounceSourceError extends Error {
  constructor(public status: number, public body: string) {
    super(`[instantly] bounce source responded ${status}: ${body.slice(0, 200)}`);
    this.name = "BounceSourceError";
  }
}

export class BounceConfigError extends Error {
  constructor() {
    super("[instantly] service URL / API key not configured");
    this.name = "BounceConfigError";
  }
}

function requireInstantly(): { url: string; key: string } {
  // Read at call time (not boot), same convention as the opt-out client.
  const url = process.env.INSTANTLY_SERVICE_URL;
  const key = process.env.INSTANTLY_SERVICE_API_KEY;
  if (!url || !key) throw new BounceConfigError();
  return { url, key };
}

// instantly-service's deployed cap per call (`emails` max 1000).
const BOUNCE_BATCH_LIMIT = 1000;

// The subset of `emails` that bounced on one of our sends, lowercased + trimmed.
// An empty input asks nothing and answers the empty set.
export async function findBouncedEmails(
  identity: Identity,
  emails: string[]
): Promise<Set<string>> {
  const normalized = [
    ...new Set(
      emails.map((e) => (e ?? "").trim().toLowerCase()).filter((e) => e.length > 0)
    ),
  ];
  const bounced = new Set<string>();
  if (normalized.length === 0) return bounced;
  const { url, key } = requireInstantly();

  for (let i = 0; i < normalized.length; i += BOUNCE_BATCH_LIMIT) {
    const batch = normalized.slice(i, i + BOUNCE_BATCH_LIMIT);
    let res: Response;
    try {
      res = await fetchWithConnectRetry(`${url}/internal/bounced-emails`, {
        method: "POST",
        headers: downstreamHeaders(key, identity),
        body: JSON.stringify({ emails: batch }),
      });
    } catch (err) {
      throw new BounceSourceError(0, String(err));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BounceSourceError(res.status, text);
    }
    const data = (await res.json()) as { bounced?: unknown };
    // `bounced` is the whole answer. A body without it is not "nobody bounced" —
    // it is a contract we cannot read, and reading it as empty would wave
    // unreachable people through.
    if (!Array.isArray(data.bounced)) {
      throw new BounceSourceError(
        res.status,
        "bounced-emails body carries no bounced array"
      );
    }
    for (const row of data.bounced as { email?: unknown }[]) {
      if (typeof row?.email === "string" && row.email.trim().length > 0) {
        bounced.add(row.email.trim().toLowerCase());
      }
    }
  }
  return bounced;
}
