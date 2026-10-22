// instantly-service's outreach FACT FEED (`GET /internal/outreach-facts`), read
// for one thing only: every REAL email it sent, so the per-brand suppression
// window runs from the send and not only from the serve
// (src/services/send-suppression-sync.ts).
//
// instantly-service OWNS the send record (it performed the terminal action);
// the feed is its own append-only projection, served in one total order by
// `seq`, so a reader paging by cursor never skips a fact. Platform-scoped
// (service key only), DB-only, no cost.
//
// Fail loud: a non-2xx / network error / a body without `facts` throws
// SendFeedSourceError, a missing env throws SendFeedConfigError. The cursor is
// only advanced after a page is applied, so a failed read loses nothing.

import { errorString } from "./db-error.js";
import { fetchWithConnectRetry } from "../services/people-providers.js";

export class SendFeedSourceError extends Error {
  constructor(public status: number, public body: string) {
    super(`[instantly] outreach fact feed responded ${status}: ${body.slice(0, 200)}`);
    this.name = "SendFeedSourceError";
  }
}

export class SendFeedConfigError extends Error {
  constructor() {
    super("[instantly] service URL / API key not configured");
    this.name = "SendFeedConfigError";
  }
}

// The feed's max page size (instantly-service OutreachFactsQuerySchema).
export const SEND_FEED_PAGE_LIMIT = 1000;

// The subset of an outreach fact this service reads.
export interface OutreachFact {
  seq: string;
  type: string;
  occurredAt: string;
  leadEmail: string;
  orgId: string | null;
  brandIds: string[];
}

export interface OutreachFactPage {
  facts: OutreachFact[];
  nextCursor: string;
  hasMore: boolean;
}

export async function readOutreachFacts(since: string): Promise<OutreachFactPage> {
  const url = process.env.INSTANTLY_SERVICE_URL;
  const key = process.env.INSTANTLY_SERVICE_API_KEY;
  if (!url || !key) throw new SendFeedConfigError();

  let res: Response;
  try {
    res = await fetchWithConnectRetry(
      `${url}/internal/outreach-facts?since=${encodeURIComponent(since)}&limit=${SEND_FEED_PAGE_LIMIT}`,
      { method: "GET", headers: { "X-API-Key": key } }
    );
  } catch (err) {
    throw new SendFeedSourceError(0, errorString(err));
  }
  if (!res.ok) {
    throw new SendFeedSourceError(res.status, await res.text().catch(() => ""));
  }
  const data = (await res.json()) as Partial<OutreachFactPage>;
  if (!Array.isArray(data.facts) || typeof data.nextCursor !== "string" || typeof data.hasMore !== "boolean") {
    throw new SendFeedSourceError(res.status, `unexpected body: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { facts: data.facts, nextCursor: data.nextCursor, hasMore: data.hasMore };
}
