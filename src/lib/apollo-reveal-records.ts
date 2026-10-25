// Client for apollo-service's stored reveal records: what Apollo's own paid
// reveal (/enrich, /match) returned for an Apollo person id
// (LEDGER-RESIDUAL-1025-HUMANS). A free read of what apollo-service already
// recorded: no Apollo call, nothing billed, nothing written.
//
// Fail loud: a non-2xx / network error / unreadable body throws
// RevealRecordSourceError, a missing env RevealRecordConfigError; both 502.
import { errorString } from "./db-error.js";
import { fetchWithConnectRetry } from "../services/people-providers.js";
import type { RevealRecord } from "../services/human-identity-provider-records.js";

export class RevealRecordSourceError extends Error {
  constructor(public status: number, public body: string) {
    super(`[apollo] reveal record responded ${status}: ${body.slice(0, 200)}`);
    this.name = "RevealRecordSourceError";
  }
}

export class RevealRecordConfigError extends Error {
  constructor() {
    super("[apollo] service URL / API key not configured");
    this.name = "RevealRecordConfigError";
  }
}

function requireApollo(): { url: string; key: string } {
  const url = process.env.APOLLO_SERVICE_URL;
  const key = process.env.APOLLO_SERVICE_API_KEY;
  if (!url || !key) throw new RevealRecordConfigError();
  return { url, key };
}

const norm = (e: string) => e.trim().toLowerCase();

export async function readApolloRevealRecords(apolloPersonIds: string[]): Promise<RevealRecord> {
  const { url, key } = requireApollo();
  const emailsByPersonId = new Map<string, string[]>();
  const personIdsByEmail = new Map<string, string[]>();
  if (apolloPersonIds.length === 0) return { emailsByPersonId, personIdsByEmail };
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}${REVEAL_RECORD_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify(requestBody(apolloPersonIds)),
    });
  } catch (err) {
    throw new RevealRecordSourceError(0, errorString(err));
  }
  if (!res.ok) throw new RevealRecordSourceError(res.status, await res.text().catch(() => ""));
  parseInto(await res.json(), emailsByPersonId, personIdsByEmail);
  return { emailsByPersonId, personIdsByEmail };
}

// apollo-service v0.39.83 (#458): POST /internal/reveal-records/by-person-ids
// {apolloPersonIds: 1..1000} -> {people: [{apolloPersonId, emails: [{email, ...}]}],
// emails: [{email, apolloPersonIds}]}. Both lists read here; its own
// `unambiguousEmail` is the same rule, decided again in human-service, where the
// merge is stated.
const REVEAL_RECORD_PATH = "/internal/reveal-records/by-person-ids";
const requestBody = (ids: string[]) => ({ apolloPersonIds: ids });

function parseInto(body: unknown, byId: Map<string, string[]>, byEmail: Map<string, string[]>): void {
  const b = body as { people?: unknown; emails?: unknown };
  // A body without both lists is a contract we cannot read, never "no record".
  if (!Array.isArray(b?.people) || !Array.isArray(b?.emails)) {
    throw new RevealRecordSourceError(200, `unreadable body: ${JSON.stringify(body).slice(0, 200)}`);
  }
  for (const p of b.people as Array<{ apolloPersonId?: unknown; emails?: unknown }>) {
    if (typeof p.apolloPersonId !== "string" || !Array.isArray(p.emails)) {
      throw new RevealRecordSourceError(200, `unreadable person entry: ${JSON.stringify(p).slice(0, 200)}`);
    }
    const emails = (p.emails as Array<{ email?: unknown }>).map((e) => {
      if (typeof e.email !== "string") throw new RevealRecordSourceError(200, "email entry without email");
      return norm(e.email);
    });
    byId.set(p.apolloPersonId, [...new Set(emails)]);
  }
  for (const e of b.emails as Array<{ email?: unknown; apolloPersonIds?: unknown }>) {
    if (typeof e.email !== "string" || !Array.isArray(e.apolloPersonIds)) {
      throw new RevealRecordSourceError(200, `unreadable email entry: ${JSON.stringify(e).slice(0, 200)}`);
    }
    byEmail.set(norm(e.email), e.apolloPersonIds.map(String));
  }
}
