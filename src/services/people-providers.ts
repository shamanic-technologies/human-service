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

const APIFY_DEFAULT_LIMIT = 100; // mirror apollo's fixed page size

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
  workflowTracking?: WorkflowTrackingHeaders;
}

// --- Provider routing ---

export function resolveProvider(opts: {
  provider?: Provider;
  need?: "verified_email";
}): Provider {
  if (opts.provider) return opts.provider;
  if (opts.need === "verified_email") return "apify";
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
    res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: downstreamHeaders(apiKey, identity),
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network-phase failure — fail loud.
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
    res = await fetch(`${baseUrl}${path}`, {
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

  // Note: neutral `functions` and `companyNames` have no apollo search filter;
  // they are honored only on the apify provider.
  return params;
}

function toApifyFilters(
  filters: PeopleSearchFilters,
  limit: number
): Record<string, unknown> {
  const body: Record<string, unknown> = { limit };
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
  isNextPage?: boolean;
  limit?: number;
  identity: Identity;
}): Promise<PeopleSearchResult> {
  const provider = resolveProvider(args);

  if (provider === "apollo") {
    const { url, key } = requireApollo();
    // Apollo owns the cursor (keyed by org + x-campaign-id). On a next-page
    // call the caller omits filters; we forward an empty body so apollo
    // advances its stored cursor.
    const body = args.isNextPage
      ? {}
      : { searchParams: toApolloSearchParams(args.filters) };
    const data = (await postProvider(
      "apollo",
      url,
      key,
      "/search/next",
      body,
      args.identity
    )) as { people: ApolloPerson[]; done: boolean; totalEntries: number };
    return {
      provider,
      people: data.people.map(normalizeApolloPerson),
      done: data.done,
      total: data.totalEntries,
    };
  }

  // apify — one-shot, no cursor. Returns everything then done=true.
  const { url, key } = requireApify();
  const limit = args.limit ?? APIFY_DEFAULT_LIMIT;
  const data = (await postProvider(
    "apify",
    url,
    key,
    "/search",
    toApifyFilters(args.filters, limit),
    args.identity
  )) as { leads: ApifyLead[]; leadCount: number; verifiedCount: number };
  return {
    provider,
    people: data.leads.map(normalizeApifyLead),
    done: true,
    total: data.leadCount,
  };
}

export async function resolveEmail(args: {
  provider?: Provider;
  firstName: string;
  lastName: string;
  domain: string;
  includeInferred?: boolean;
  identity: Identity;
}): Promise<ResolveEmailResult> {
  // Default to apify — verified email is its specialty. Explicit provider wins.
  const provider = args.provider ?? "apify";

  if (provider === "apollo") {
    const { url, key } = requireApollo();
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
    return {
      provider,
      person: data.person ? normalizeApolloPerson(data.person) : null,
    };
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
  return { provider, person: lead ? normalizeApifyLead(lead) : null };
}

export async function dryRun(args: {
  provider?: Provider;
  filters: PeopleSearchFilters;
  identity: Identity;
}): Promise<{ provider: Provider; totalEntries: number }> {
  const provider = resolveProvider(args);
  if (provider === "apify") {
    // apify-service has no free count endpoint yet (apify-service#6).
    throw new ProviderUnsupportedError("apify", "dry-run");
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
  if (provider === "apify") {
    throw new ProviderUnsupportedError("apify", "filters-prompt");
  }
  const { url, key } = requireApollo();
  const data = (await getProvider(
    "apollo",
    url,
    key,
    "/search/filters-prompt",
    args.identity
  )) as { prompt: string; schemaVersion: string };
  return { provider, prompt: data.prompt, schemaVersion: data.schemaVersion };
}
