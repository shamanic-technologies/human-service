// Client for apollo-service's stored person facts (BLANK-CANDIDATES-1101): what our stored paid reveals of an Apollo
// person id said about the PERSON (title, headline, seniority, place) and their employer. A free read of what
// apollo-service already recorded: no Apollo call, nothing billed, nothing written. Feeds person-teaser.ts for people
// served before teaser snapshots were stored (2026-09-17), so a candidate is never offered blank.
//
// Fail loud: a non-2xx / network error / unreadable body throws PersonFactsSourceError, a missing env
// PersonFactsConfigError.
import { errorString } from "./db-error.js";
import { fetchWithConnectRetry } from "../services/people-providers.js";
import type { TeaserSnapshot } from "../db/schema.js";

export class PersonFactsSourceError extends Error {
  constructor(public status: number, public body: string) {
    super(`[apollo] person facts responded ${status}: ${body.slice(0, 200)}`);
    this.name = "PersonFactsSourceError";
  }
}

export class PersonFactsConfigError extends Error {
  constructor() {
    super("[apollo] service URL / API key not configured");
    this.name = "PersonFactsConfigError";
  }
}

// apollo-service v0.39.93: POST /internal/reveal-records/person-facts {apolloPersonIds: 1..1000}.
const PATH = "/internal/reveal-records/person-facts";
const BATCH = 1000;
const KEYWORDS_CAP = 20;

interface FactsEntry {
  apolloPersonId?: unknown;
  known?: unknown;
  title?: string | null;
  headline?: string | null;
  seniority?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  organization?: {
    name?: string | null;
    industry?: string | null;
    employees?: number | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    keywords?: string[] | null;
  } | null;
}

/** The teaser snapshot our stored reveals hold for each known id (unknown ids are absent). */
export async function readApolloPersonFacts(apolloPersonIds: string[]): Promise<Map<string, TeaserSnapshot>> {
  const url = process.env.APOLLO_SERVICE_URL;
  const key = process.env.APOLLO_SERVICE_API_KEY;
  if (!url || !key) throw new PersonFactsConfigError();
  const ids = [...new Set(apolloPersonIds.map((i) => i.trim()).filter((i) => i.length > 0))];
  const out = new Map<string, TeaserSnapshot>();
  for (let i = 0; i < ids.length; i += BATCH) {
    let res: Response;
    try {
      res = await fetchWithConnectRetry(`${url}${PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({ apolloPersonIds: ids.slice(i, i + BATCH) }),
      });
    } catch (err) {
      throw new PersonFactsSourceError(0, errorString(err));
    }
    if (!res.ok) throw new PersonFactsSourceError(res.status, await res.text().catch(() => ""));
    const body = (await res.json()) as { people?: unknown };
    // A body without the list is a contract we cannot read, never "nothing known".
    if (!Array.isArray(body?.people)) throw new PersonFactsSourceError(200, `unreadable body: ${JSON.stringify(body).slice(0, 200)}`);
    for (const p of body.people as FactsEntry[]) {
      if (typeof p.apolloPersonId !== "string") throw new PersonFactsSourceError(200, "entry without apolloPersonId");
      if (p.known !== true) continue;
      const o = p.organization ?? null;
      out.set(p.apolloPersonId, {
        name: null,
        title: p.title ?? null,
        headline: p.headline ?? null,
        seniority: p.seniority ?? null,
        city: p.city ?? null,
        state: p.state ?? null,
        country: p.country ?? null,
        organizationName: o?.name ?? null,
        organizationIndustry: o?.industry ?? null,
        organizationEmployees: o?.employees ?? null,
        organizationCity: o?.city ?? null,
        organizationState: o?.state ?? null,
        organizationCountry: o?.country ?? null,
        organizationKeywords: o?.keywords && o.keywords.length > 0 ? o.keywords.slice(0, KEYWORDS_CAP) : null,
      });
    }
  }
  return out;
}
