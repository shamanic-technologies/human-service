// People provider gateway — routes neutral people-search / email-resolution
// requests to either apollo-service (rich search + enrich) or apify-service
// (verified-email waterfall), and normalizes both into one neutral `Person`
// shape whose field names mirror lead-service's `FullLead` so the future
// Sales Lead Service mapping is trivial.
//
// Cost tracking stays with apollo/apify-service (they make the paid calls).
// This module only forwards identity + run-tracking headers and FAILS LOUD:
// a provider error propagates as a thrown ProviderError (→ 502 at the route),
// never a silent fallback, because a gateway that masks a provider outage
// lies to the caller.

import type { WorkflowTrackingHeaders } from "../middleware/auth.js";
import { workflowTrackingToHeaders } from "../middleware/auth.js";
import {
  filterSuppressed,
  getSuppressionSet,
  isEmailSuppressed,
  recordServe,
  type ServedContact,
} from "./suppression.js";

// apollo search is FREE (only enrich is billed), so on a brand-saturated
// audience we can page the free cursor and drop already-served teasers without
// spending. Cap how many consecutive all-served pages we scan before returning
// a truthful per-brand `done` — producer-side saturation stop (the gateway IS
// lead-service's producer), bounded so we never deep-page forever.
const APOLLO_MAX_SATURATION_PAGES = 5;

// apify bills per RETURNED lead (each search hit carries a verified email — there
// is no free teaser list like apollo's). So the gateway takes the strict minimum
// by default: one lead per call. A caller that consciously wants a batch passes
// an explicit `limit`. apollo is unaffected (cursor-based, ignores `limit`).
const APIFY_DEFAULT_LIMIT = 1;

export type Provider = "apollo" | "apify";

// --- Errors (fail-loud) ---

export class ProviderError extends Error {
  constructor(
    public provider: Provider,
    public status: number,
    public body: string
  ) {
    super(`[${provider}] upstream responded ${status}: ${body.slice(0, 200)}`);
    this.name = "ProviderError";
  }
}

export class ProviderConfigError extends Error {
  constructor(public provider: Provider) {
    super(`[${provider}] service URL / API key not configured`);
    this.name = "ProviderConfigError";
  }
}

export class ProviderUnsupportedError extends Error {
  constructor(
    public provider: Provider,
    public capability: string
  ) {
    super(`[${provider}] does not support "${capability}" yet`);
    this.name = "ProviderUnsupportedError";
  }
}

// --- Neutral shapes ---

export const SENIORITIES = [
  "entry",
  "senior",
  "manager",
  "director",
  "vp",
  "c_suite",
  "owner",
  "founder",
  "partner",
] as const;

export interface PeopleSearchFilters {
  titles?: string[];
  seniorities?: string[];
  functions?: string[];
  locationCountries?: string[];
  locationStates?: string[];
  locationCities?: string[];
  companyNames?: string[];
  companyDomains?: string[];
  industries?: string[];
  keywords?: string[];
  employeeMin?: number;
  employeeMax?: number;
  // Rich filters. apify honors all four; apollo honors revenueRanges (revenueRange)
  // and technologies (currentlyUsingAnyOfTechnologyUids) only.
  companySizes?: string[];
  revenueRanges?: string[];
  fundingStages?: string[];
  technologies?: string[];
}

export interface NeutralOrganization {
  name: string | null;
  domain: string | null;
  websiteUrl: string | null;
  industry: string | null;
  estimatedNumEmployees: number | null;
  linkedinUrl: string | null;
  logoUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

// Field names mirror lead-service FullLead (provider-independent).
export interface Person {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  title: string | null;
  headline: string | null;
  seniority: string | null;
  email: string | null;
  emailStatus: string | null;
  // apify-specific deliverability signals; null for apollo
  catchAll: boolean | null;
  inferred: boolean | null;
  linkedinUrl: string | null;
  photoUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  provider: Provider;
  // apollo person id — usable for a later enrich/resolve. null for apify.
  providerPersonId: string | null;
  organization: NeutralOrganization | null;
}

export interface PeopleSearchResult {
  provider: Provider;
  people: Person[];
  done: boolean;
  total: number;
  // apify offset cursor for the next page (null when done / apollo cursor-based).
  nextOffset: number | null;
}

export interface ResolveEmailResult {
  provider: Provider;
  person: Person | null;
}

export interface Identity {
  orgId: string;
  userId?: string;
  runId?: string;
  campaignId?: string;
  // Atomic brands this request serves leads for. Drives per-brand cross-provider
  // suppression. Empty / absent ⟹ no suppression (nothing to scope against).
  brandIds?: string[];
  workflowTracking?: WorkflowTrackingHeaders;
}

// Map a normalized neutral Person to the suppression/membership contact shape.
export function toServedContact(p: Person): ServedContact {
  return {
    email: p.email,
    linkedinUrl: p.linkedinUrl,
    firstName: p.firstName,
    lastName: p.lastName,
    companyDomain: p.organization?.domain ?? null,
    provider: p.provider,
    providerPersonId: p.providerPersonId,
  };
}

// --- Provider routing ---

export function resolveProvider(opts: {
  provider?: Provider;
  need?: "verified_email";
}): Provider {
  if (opts.provider) return opts.provider;
  // APOLLO-ONLY (2026-06): apify is no longer auto-selected. The default
  // (incl. `need: "verified_email"`, formerly → apify) now resolves to apollo —
  // apollo reveals verified emails via the billed `resolve-email` enrich path.
  // An EXPLICIT `provider: "apify"` is still honored above (existing apify
  // audiences' serve-next), but nothing selects apify by default anymore.
  // if (opts.need === "verified_email") return "apify";
  return "apollo";
}

// --- Header builder ---

function downstreamHeaders(
  apiKey: string,
  identity: Identity
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    "x-org-id": identity.orgId,
    ...(identity.userId ? { "x-user-id": identity.userId } : {}),
    ...(identity.runId ? { "x-run-id": identity.runId } : {}),
    ...(identity.campaignId ? { "x-campaign-id": identity.campaignId } : {}),
    ...workflowTrackingToHeaders(identity.workflowTracking ?? {}),
  };
}

const TRANSIENT_CODES = ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN"];
const RETRY_BACKOFF_MS = [250, 500, 1000];

// Walk err.cause / AggregateError.errors for a transient connect-phase code.
// apollo/apify are Neon-backed siblings; their first request after an idle
// scale-to-zero lands mid-wake and rejects with `fetch failed` whose cause is
// ECONNRESET/ETIMEDOUT/ECONNREFUSED. See CLAUDE.md "second surface".
function isTransientConnectError(err: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (e: unknown): boolean => {
    if (!e || typeof e !== "object" || seen.has(e)) return false;
    seen.add(e);
    const anyE = e as { code?: string; cause?: unknown; errors?: unknown[]; message?: string };
    if (anyE.code && TRANSIENT_CODES.includes(anyE.code)) return true;
    if (typeof anyE.message === "string" && /fetch failed|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(anyE.message))
      return true;
    if (Array.isArray(anyE.errors) && anyE.errors.some(visit)) return true;
    return visit(anyE.cause);
  };
  return visit(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Connect-phase retry on a THROWN rejection only — never on a completed HTTP
// response (an HTTP 5xx is a real answer that may have side-effected). Safe for
// POSTs because the request never reached the server when fetch itself rejects.
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

async function postProvider(
  provider: Provider,
  baseUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
  identity: Identity
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${baseUrl}${path}`, {
      method: "POST",
      headers: downstreamHeaders(apiKey, identity),
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network-phase failure after retries — fail loud.
    throw new ProviderError(provider, 0, String(err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(provider, res.status, text);
  }
  return res.json();
}

async function getProvider(
  provider: Provider,
  baseUrl: string,
  apiKey: string,
  path: string,
  identity: Identity
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${baseUrl}${path}`, {
      method: "GET",
      headers: downstreamHeaders(apiKey, identity),
    });
  } catch (err) {
    throw new ProviderError(provider, 0, String(err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(provider, res.status, text);
  }
  return res.json();
}

function requireApollo(): { url: string; key: string } {
  const url = process.env.APOLLO_SERVICE_URL;
  const key = process.env.APOLLO_SERVICE_API_KEY;
  if (!url || !key) throw new ProviderConfigError("apollo");
  return { url, key };
}

// Thin apollo HTTP helpers exported for the apollo-audiences client (the "one
// filter vocabulary" Wave 2 pointer endpoints live in src/lib/apollo-audiences.ts
// but reuse this module's single apollo HTTP layer — requireApollo + the
// connect-phase retry + the downstream-header builder + ProviderError — so there
// is exactly ONE place that talks to apollo-service). Fail loud: a non-2xx /
// network error throws ProviderError, a missing env throws ProviderConfigError.
export async function apolloPost(
  path: string,
  body: unknown,
  identity: Identity
): Promise<unknown> {
  const { url, key } = requireApollo();
  return postProvider("apollo", url, key, path, body, identity);
}

export async function apolloGet(
  path: string,
  identity: Identity
): Promise<unknown> {
  const { url, key } = requireApollo();
  return getProvider("apollo", url, key, path, identity);
}

function requireApify(): { url: string; key: string } {
  const url = process.env.APIFY_SERVICE_URL;
  const key = process.env.APIFY_SERVICE_API_KEY;
  if (!url || !key) throw new ProviderConfigError("apify");
  return { url, key };
}

// --- Filter mapping: neutral → apollo ---

const APOLLO_EMPLOYEE_RANGES: Array<[number, number, string]> = [
  [1, 10, "1,10"],
  [11, 20, "11,20"],
  [21, 50, "21,50"],
  [51, 100, "51,100"],
  [101, 200, "101,200"],
  [201, 500, "201,500"],
  [501, 1000, "501,1000"],
  [1001, 2000, "1001,2000"],
  [2001, 5000, "2001,5000"],
  [5001, 10000, "5001,10000"],
  [10001, Infinity, "10001,"],
];

// Convert a neutral [min,max] employee window into the overlapping apollo
// enum buckets. Lossy by nature (apollo only filters by bucket).
export function apolloEmployeeRanges(
  min?: number,
  max?: number
): string[] {
  if (min === undefined && max === undefined) return [];
  const lo = min ?? 0;
  const hi = max ?? Infinity;
  return APOLLO_EMPLOYEE_RANGES.filter(
    ([bLo, bHi]) => bHi >= lo && bLo <= hi
  ).map(([, , label]) => label);
}

function toApolloSearchParams(
  filters: PeopleSearchFilters
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (filters.titles?.length) params.personTitles = filters.titles;
  if (filters.seniorities?.length)
    params.personSeniorities = filters.seniorities;
  if (filters.industries?.length)
    params.qOrganizationIndustryTagIds = filters.industries;
  if (filters.companyDomains?.length)
    params.qOrganizationDomains = filters.companyDomains;

  const personLocations = [
    ...(filters.locationCities ?? []),
    ...(filters.locationStates ?? []),
    ...(filters.locationCountries ?? []),
  ];
  if (personLocations.length) params.personLocations = personLocations;

  if (filters.keywords?.length)
    params.qKeywords = filters.keywords.join(" OR ");

  const ranges = apolloEmployeeRanges(filters.employeeMin, filters.employeeMax);
  if (ranges.length) params.organizationNumEmployeesRanges = ranges;

  if (filters.revenueRanges?.length) params.revenueRange = filters.revenueRanges;
  if (filters.technologies?.length)
    params.currentlyUsingAnyOfTechnologyUids = filters.technologies;

  // Note: neutral `functions`, `companyNames`, `companySizes`, `fundingStages`
  // have no apollo search filter; they are honored only on the apify provider.
  return params;
}

// Flat apify filter body (no limit/offset). Used by /search (+ limit/offset)
// and /search/count (alone).
function toApifyFilterBody(
  filters: PeopleSearchFilters
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (filters.titles?.length) body.titles = filters.titles;
  if (filters.seniorities?.length) body.seniorities = filters.seniorities;
  if (filters.functions?.length) body.functions = filters.functions;
  if (filters.locationCountries?.length)
    body.locationCountries = filters.locationCountries;
  if (filters.locationStates?.length)
    body.locationStates = filters.locationStates;
  if (filters.locationCities?.length)
    body.locationCities = filters.locationCities;
  if (filters.companyNames?.length) body.companyNames = filters.companyNames;
  if (filters.companyDomains?.length)
    body.companyDomains = filters.companyDomains;
  if (filters.industries?.length) body.industries = filters.industries;
  if (filters.keywords?.length) body.keywords = filters.keywords;
  if (filters.companySizes?.length) body.companySizes = filters.companySizes;
  if (filters.revenueRanges?.length) body.revenueRanges = filters.revenueRanges;
  if (filters.fundingStages?.length) body.fundingStages = filters.fundingStages;
  if (filters.technologies?.length) body.technologies = filters.technologies;
  if (filters.employeeMin !== undefined) body.employeeMin = filters.employeeMin;
  if (filters.employeeMax !== undefined) body.employeeMax = filters.employeeMax;
  return body;
}

// --- Normalization: apollo / apify → neutral Person ---

interface ApolloPerson {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string | null;
  emailStatus: string | null;
  title: string | null;
  headline: string | null;
  seniority: string | null;
  linkedinUrl: string | null;
  photoUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  organizationName: string | null;
  organizationDomain: string | null;
  organizationWebsiteUrl: string | null;
  organizationIndustry: string | null;
  organizationSize: string | null;
  organizationLinkedinUrl: string | null;
  organizationLogoUrl: string | null;
  organizationCity: string | null;
  organizationState: string | null;
  organizationCountry: string | null;
}

function parseEmployees(size: string | null): number | null {
  if (!size) return null;
  const n = Number(size);
  return Number.isFinite(n) ? n : null;
}

function normalizeApolloPerson(p: ApolloPerson): Person {
  const hasOrg =
    p.organizationName ||
    p.organizationDomain ||
    p.organizationWebsiteUrl ||
    p.organizationIndustry;
  return {
    firstName: p.firstName,
    lastName: p.lastName,
    name: p.name,
    title: p.title,
    headline: p.headline,
    seniority: p.seniority,
    email: p.email,
    emailStatus: p.emailStatus,
    catchAll: p.emailStatus === "catch_all" ? true : null,
    inferred: p.emailStatus === "extrapolated" ? true : null,
    linkedinUrl: p.linkedinUrl,
    photoUrl: p.photoUrl,
    city: p.city,
    state: p.state,
    country: p.country,
    provider: "apollo",
    providerPersonId: p.id,
    organization: hasOrg
      ? {
          name: p.organizationName,
          domain: p.organizationDomain,
          websiteUrl: p.organizationWebsiteUrl,
          industry: p.organizationIndustry,
          estimatedNumEmployees: parseEmployees(p.organizationSize),
          linkedinUrl: p.organizationLinkedinUrl,
          logoUrl: p.organizationLogoUrl,
          city: p.organizationCity,
          state: p.organizationState,
          country: p.organizationCountry,
        }
      : null,
  };
}

interface ApifyLead {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  title: string | null;
  seniority: string | null;
  email: string;
  emailStatus: string;
  source: string;
  isCatchAll: boolean;
  isInferred: boolean;
  linkedinUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  companyName: string | null;
  companyDomain: string | null;
  companyIndustry: string | null;
  companySize: number | null;
  companyLinkedinUrl: string | null;
}

function normalizeApifyLead(l: ApifyLead): Person {
  const hasOrg =
    l.companyName || l.companyDomain || l.companyIndustry || l.companyLinkedinUrl;
  return {
    firstName: l.firstName,
    lastName: l.lastName,
    name: l.fullName,
    title: l.title,
    headline: null,
    seniority: l.seniority,
    email: l.email,
    emailStatus: l.emailStatus,
    catchAll: l.isCatchAll,
    inferred: l.isInferred,
    linkedinUrl: l.linkedinUrl,
    photoUrl: null,
    city: l.city,
    state: l.state,
    country: l.country,
    provider: "apify",
    providerPersonId: null,
    organization: hasOrg
      ? {
          name: l.companyName,
          domain: l.companyDomain,
          websiteUrl: null,
          industry: l.companyIndustry,
          estimatedNumEmployees: l.companySize,
          linkedinUrl: l.companyLinkedinUrl,
          logoUrl: null,
          city: l.city,
          state: l.state,
          country: l.country,
        }
      : null,
  };
}

// --- Public operations ---

export async function peopleSearch(args: {
  provider?: Provider;
  need?: "verified_email";
  filters: PeopleSearchFilters;
  // Apollo-native search params forwarded VERBATIM as the apollo /search body
  // ("one filter vocabulary" Wave 2): an audience's stored filters are ALREADY
  // Apollo's faithful shape (sourced from apollo-service), so serve-next passes
  // them through here instead of remapping a neutral set via toApolloSearchParams.
  // apollo-only; ignored on the apify branch (apify keeps the neutral filters).
  // When set, it takes precedence over `filters` for the apollo search body.
  apolloSearchParams?: Record<string, unknown>;
  isNextPage?: boolean;
  limit?: number;
  offset?: number;
  // Audience to record bronze serves under (membership tagging is done by the
  // route after the result returns). Audit-only here.
  audienceId?: string;
  identity: Identity;
}): Promise<PeopleSearchResult> {
  const provider = resolveProvider(args);
  const brandIds = args.identity.brandIds ?? [];

  if (provider === "apollo") {
    const { url, key } = requireApollo();
    // Apollo owns the cursor (keyed by org + x-campaign-id). The first call
    // sends searchParams; next-page calls send an empty body so apollo advances
    // its stored cursor.
    //
    // Per-brand suppression: apollo search is FREE, so we drop teasers already
    // served for the brand (linkedin / person-id match) BEFORE paying to reveal
    // their email. If a page is entirely already-served, we page the free cursor
    // again — bounded — and return a truthful per-brand `done` on saturation, so
    // a saturated audience exhausts without the caller deep-paging forever.
    const firstBody = args.isNextPage
      ? {}
      : {
          searchParams:
            args.apolloSearchParams ?? toApolloSearchParams(args.filters),
        };

    const collected: Person[] = [];
    let total = 0;
    let done = false;
    // Without brandIds there is nothing to suppress against — single page, the
    // caller drives pagination exactly as before.
    const maxPages = brandIds.length > 0 ? APOLLO_MAX_SATURATION_PAGES : 1;

    for (let page = 0; page < maxPages; page++) {
      const data = (await postProvider(
        "apollo",
        url,
        key,
        "/search/next",
        page === 0 ? firstBody : {},
        args.identity
      )) as { people: ApolloPerson[]; done: boolean; totalEntries: number };
      total = data.totalEntries;

      let people = data.people.map(normalizeApolloPerson);
      if (brandIds.length > 0) {
        people = await filterSuppressed(args.identity.orgId, brandIds, people);
      }
      collected.push(...people);

      if (data.done) {
        done = true;
        break;
      }
      // Got fresh (non-suppressed) leads, or suppression is off → return them
      // and let the caller request the next page.
      if (brandIds.length === 0 || people.length > 0) break;
      // Whole page already served for the brand — try the next free page.
    }

    // Brand-scoped search that scanned the bounded page budget and found zero
    // fresh leads ⟹ audience saturated for this brand → terminal.
    if (brandIds.length > 0 && collected.length === 0 && !done) done = true;

    return { provider, people: collected, done, total, nextOffset: null };
  }

  // apify — offset-based pagination (apify-service#6). totalMatched / hasMore /
  // nextOffset are pipelinelabs-only signals (microworlds contributes page 1
  // only) — a provider-specific cursor, NOT a cross-source-exact total.
  //
  // Per-brand suppression: apify BILLS per returned lead, so we cannot post-
  // filter (that pays for trash). We push the brand's exclude-set down so apify
  // never returns / bills a lead already served for the brand, and stops once
  // the fresh pool is dry (apify-service#18 saturation-stop). Every returned
  // lead carries a verified email ⟹ it IS a serve, recorded here.
  const { url, key } = requireApify();
  const limit = args.limit ?? APIFY_DEFAULT_LIMIT;
  const exclude =
    brandIds.length > 0
      ? await getSuppressionSet(args.identity.orgId, brandIds)
      : { emails: [], linkedinUrls: [] };
  const data = (await postProvider(
    "apify",
    url,
    key,
    "/search",
    {
      ...toApifyFilterBody(args.filters),
      limit,
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(exclude.emails.length > 0 ? { excludeEmails: exclude.emails } : {}),
      ...(exclude.linkedinUrls.length > 0
        ? { excludeLinkedinUrls: exclude.linkedinUrls }
        : {}),
    },
    args.identity
  )) as {
    leads: ApifyLead[];
    leadCount: number;
    verifiedCount: number;
    totalMatched?: number;
    hasMore?: boolean;
    nextOffset?: number;
  };
  const apifyPeople = data.leads.map(normalizeApifyLead);
  if (brandIds.length > 0 && apifyPeople.length > 0) {
    await recordServe(
      args.identity.orgId,
      brandIds,
      apifyPeople.map(toServedContact),
      {
        campaignId: args.identity.campaignId,
        runId: args.identity.runId,
        audienceId: args.audienceId,
      }
    );
  }
  return {
    provider,
    people: apifyPeople,
    done: data.hasMore !== true,
    total: data.totalMatched ?? data.leadCount,
    nextOffset: data.hasMore === true ? data.nextOffset ?? null : null,
  };
}

// After a billed reveal, apply per-brand suppression: block re-emission (the
// credit is already spent, but a lead already served for the brand must not be
// handed back again) and otherwise record the serve. No brandIds ⟹ pass through.
async function finalizeResolved(
  provider: Provider,
  person: Person | null,
  identity: Identity,
  audienceId?: string
): Promise<ResolveEmailResult> {
  if (!person) return { provider, person };
  const brandIds = identity.brandIds ?? [];
  if (
    brandIds.length > 0 &&
    (await isEmailSuppressed(identity.orgId, brandIds, person.email))
  ) {
    return { provider, person: null };
  }
  if (brandIds.length > 0) {
    await recordServe(identity.orgId, brandIds, [toServedContact(person)], {
      campaignId: identity.campaignId,
      runId: identity.runId,
      audienceId,
    });
  }
  return { provider, person };
}

export async function resolveEmail(args: {
  provider?: Provider;
  // apollo person id from a prior search — the preferred apollo reveal handle.
  providerPersonId?: string;
  firstName?: string;
  lastName?: string;
  domain?: string;
  includeInferred?: boolean;
  // Audience to record the bronze serve under (membership tagging is done by the
  // route after this returns).
  audienceId?: string;
  identity: Identity;
}): Promise<ResolveEmailResult> {
  // Default to apollo (same default as search). The reveal follows the provider
  // that searched: a providerPersonId is provider-specific (an apollo id means
  // nothing to apify), so we never cross providers — the caller picks the
  // provider at search time and the reveal inherits it.
  const provider = args.provider ?? "apollo";
  const hasIdentity = !!(args.firstName && args.lastName && args.domain);

  if (provider === "apollo") {
    const { url, key } = requireApollo();
    // PREFERRED: reveal by apollo person id via /enrich — the BILLED path
    // (1 apollo-credit per verified email). apollo search returns only a teaser
    // (first name + person id) and masks last name + domain, so identity-based
    // /match can't be satisfied from a search hit. Enrich-by-id is the reveal
    // that actually works for an apollo-sourced lead.
    if (args.providerPersonId) {
      const data = (await postProvider(
        "apollo",
        url,
        key,
        "/enrich",
        { apolloPersonId: args.providerPersonId },
        args.identity
      )) as { person: ApolloPerson | null };
      return finalizeResolved(
        provider,
        data.person ? normalizeApolloPerson(data.person) : null,
        args.identity,
        args.audienceId
      );
    }
    // Fallback: identity-based match (name + domain) when no person id is known
    // (e.g. a direct caller resolving a known contact). Also bills via /match.
    if (hasIdentity) {
      const data = (await postProvider(
        "apollo",
        url,
        key,
        "/match",
        {
          firstName: args.firstName,
          lastName: args.lastName,
          organizationDomain: args.domain,
        },
        args.identity
      )) as { person: ApolloPerson | null };
      return finalizeResolved(
        provider,
        data.person ? normalizeApolloPerson(data.person) : null,
        args.identity,
        args.audienceId
      );
    }
    // Unreachable when called via the route (Zod refine guarantees one path);
    // defensive fail-loud for direct callers.
    throw new ProviderError(
      "apollo",
      0,
      "resolve-email requires providerPersonId or firstName+lastName+domain"
    );
  }

  // apify — verified-email waterfall by identity. apify has no person-id enrich,
  // so a providerPersonId-only request can't be served: fail loud (501) rather
  // than silently cross to a different mechanism.
  if (args.providerPersonId && !hasIdentity) {
    throw new ProviderUnsupportedError("apify", "enrich-by-person-id");
  }
  if (!hasIdentity) {
    throw new ProviderError(
      "apify",
      0,
      "resolve-email requires firstName+lastName+domain"
    );
  }
  const { url, key } = requireApify();
  const data = (await postProvider(
    "apify",
    url,
    key,
    "/resolve",
    {
      leads: [
        {
          firstName: args.firstName,
          lastName: args.lastName,
          companyDomain: args.domain,
        },
      ],
      ...(args.includeInferred !== undefined
        ? { includeInferred: args.includeInferred }
        : {}),
    },
    args.identity
  )) as { leads: ApifyLead[] };
  const lead = data.leads[0];
  return finalizeResolved(
    provider,
    lead ? normalizeApifyLead(lead) : null,
    args.identity,
    args.audienceId
  );
}

export async function dryRun(args: {
  provider?: Provider;
  filters: PeopleSearchFilters;
  identity: Identity;
}): Promise<{ provider: Provider; totalEntries: number }> {
  const provider = resolveProvider(args);
  if (provider === "apify") {
    // apify-service#6: free count, zero credit, zero persistence.
    const { url, key } = requireApify();
    const data = (await postProvider(
      "apify",
      url,
      key,
      "/search/count",
      toApifyFilterBody(args.filters),
      args.identity
    )) as { totalMatched: number };
    return { provider, totalEntries: data.totalMatched };
  }
  const { url, key } = requireApollo();
  const data = (await postProvider(
    "apollo",
    url,
    key,
    "/search/dry-run",
    toApolloSearchParams(args.filters),
    args.identity
  )) as { totalEntries: number };
  return { provider, totalEntries: data.totalEntries };
}

export async function filtersPrompt(args: {
  provider?: Provider;
  identity: Identity;
}): Promise<{ provider: Provider; prompt: string; schemaVersion: string }> {
  const provider = args.provider ?? "apollo";
  const { url, key } = provider === "apify" ? requireApify() : requireApollo();
  const data = (await getProvider(
    provider,
    url,
    key,
    "/search/filters-prompt",
    args.identity
  )) as { prompt: string; schemaVersion: string };
  return { provider, prompt: data.prompt, schemaVersion: data.schemaVersion };
}

// Apollo's industries filter (`qOrganizationIndustryTagIds`) is a free-text
// string[] in apollo's schema, so apollo's filters-prompt documents only an
// EXAMPLE value, NOT the canonical 148-entry LinkedIn taxonomy apollo actually
// matches against. An LLM guessing "SaaS" instead of "Computer Software" yields
// a silent zero-match (apollo drops the unrecognized value). We fetch the
// authoritative list (apollo GET /reference/industries) and inject it into the
// layer-2 prompt so the model can only pick exact, matchable values. apify needs
// no equivalent: its filters-prompt already embeds the full accepted-value enum.
export async function apolloIndustriesReference(args: {
  identity: Identity;
}): Promise<string[]> {
  const { url, key } = requireApollo();
  const data = (await getProvider(
    "apollo",
    url,
    key,
    "/reference/industries",
    args.identity
  )) as { industries: Array<{ name?: string }> };
  return data.industries
    .map((i) => i.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}
