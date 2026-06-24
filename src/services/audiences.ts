// Audiences: saved persona/ICP filter-sets, canonical people dedup, and
// provenance-based membership tagging.
//
// A person joins an audience iff a serve made UNDER that audience returned them
// (provenance). We never re-implement provider matching locally — membership is
// "the audience's search returned this person", which matches provider semantics
// exactly. One person accrues many audiences over time as different audiences'
// searches surface them.
//
//   resolvePersonId   — dedup an incoming served contact into the canonical
//                       `people` dimension (email_norm -> linkedin -> provider id).
//   tagAudienceServe  — upsert the person + the audience_members bridge row.
//   refreshCounts     — re-snapshot per-provider counts via the free dry-run.
//   computeStats      — given a list of emails/personIds, return per-audience
//                       membership + counts.
//
// No silent fallbacks: a provider error during refreshCounts propagates (502).

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audienceMembers, audiences, people } from "../db/schema.js";
import {
  normalizeEmail,
  normalizeLinkedinUrl,
  type ServedContact,
} from "./suppression.js";
import {
  apolloIndustriesReference,
  dryRun,
  filtersPrompt,
  peopleSearch,
  resolveEmail,
  toServedContact,
  ProviderError,
  type Identity,
  type Person,
  type PeopleSearchFilters,
  type Provider,
} from "./people-providers.js";
import {
  completeJson,
  platformCompleteJson,
  generateImage,
  platformGenerateImage,
  ChatServiceError,
} from "../lib/chat-client.js";
import { PeopleSearchFiltersSchema } from "../schemas.js";

// The transaction handle drizzle passes to the `db.transaction` callback.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Resolve (dedup) a served contact into the canonical `people` dimension,
// returning its person id. Match order: email_norm (canonical) -> linkedin ->
// provider person id. Merges newly-learned identity fields onto the existing row
// (coalesce: prefer the new value, keep the old when the new is null).
async function resolvePersonId(
  tx: Tx,
  orgId: string,
  c: ServedContact
): Promise<string> {
  const emailNorm = normalizeEmail(c.email);
  const linkedinNorm = normalizeLinkedinUrl(c.linkedinUrl);
  const apolloId =
    c.provider === "apollo" && c.providerPersonId ? c.providerPersonId : null;
  const apifyId =
    c.provider === "apify" && c.providerPersonId ? c.providerPersonId : null;

  const keyConds = [];
  if (emailNorm) keyConds.push(eq(people.emailNorm, emailNorm));
  if (linkedinNorm) keyConds.push(eq(people.linkedinUrlNorm, linkedinNorm));
  if (apolloId) keyConds.push(eq(people.apolloPersonId, apolloId));
  if (apifyId) keyConds.push(eq(people.apifyPersonId, apifyId));

  const fullName =
    c.firstName || c.lastName
      ? [c.firstName, c.lastName].filter(Boolean).join(" ")
      : null;

  if (keyConds.length > 0) {
    const [existing] = await tx
      .select()
      .from(people)
      .where(and(eq(people.orgId, orgId), or(...keyConds)))
      .limit(1);
    if (existing) {
      await tx
        .update(people)
        .set({
          emailNorm: emailNorm ?? existing.emailNorm,
          linkedinUrlNorm: linkedinNorm ?? existing.linkedinUrlNorm,
          apolloPersonId: apolloId ?? existing.apolloPersonId,
          apifyPersonId: apifyId ?? existing.apifyPersonId,
          firstName: c.firstName ?? existing.firstName,
          lastName: c.lastName ?? existing.lastName,
          fullName: fullName ?? existing.fullName,
          companyDomain: c.companyDomain ?? existing.companyDomain,
          lastSeenAt: new Date(),
        })
        .where(eq(people.id, existing.id));
      return existing.id;
    }
  }

  // No match — insert. ON CONFLICT (org_id, email_norm) covers the race where a
  // concurrent serve created the same email between the select and the insert.
  if (emailNorm) {
    const [row] = await tx
      .insert(people)
      .values({
        orgId,
        emailNorm,
        linkedinUrlNorm: linkedinNorm,
        apolloPersonId: apolloId,
        apifyPersonId: apifyId,
        firstName: c.firstName,
        lastName: c.lastName,
        fullName,
        companyDomain: c.companyDomain,
      })
      .onConflictDoUpdate({
        target: [people.orgId, people.emailNorm],
        set: {
          linkedinUrlNorm: sql`coalesce(excluded.linkedin_url_norm, ${people.linkedinUrlNorm})`,
          apolloPersonId: sql`coalesce(excluded.apollo_person_id, ${people.apolloPersonId})`,
          apifyPersonId: sql`coalesce(excluded.apify_person_id, ${people.apifyPersonId})`,
          lastSeenAt: sql`now()`,
        },
      })
      .returning({ id: people.id });
    return row.id;
  }

  const [row] = await tx
    .insert(people)
    .values({
      orgId,
      emailNorm: null,
      linkedinUrlNorm: linkedinNorm,
      apolloPersonId: apolloId,
      apifyPersonId: apifyId,
      firstName: c.firstName,
      lastName: c.lastName,
      fullName,
      companyDomain: c.companyDomain,
    })
    .returning({ id: people.id });
  return row.id;
}

// Tag served contacts as members of an audience (provenance membership). Upserts
// the canonical person, then the audience_members bridge row (idempotent on
// (audience_id, person_id) — re-serving just bumps last_served_at).
//
// The caller MUST have validated that `audienceId` belongs to `orgId` (the route
// does this before any provider spend) so cross-org tagging is impossible.
export async function tagAudienceServe(
  orgId: string,
  audienceId: string,
  contacts: ServedContact[]
): Promise<void> {
  if (contacts.length === 0) return;

  for (const c of contacts) {
    await db.transaction(async (tx) => {
      const personId = await resolvePersonId(tx, orgId, c);
      await tx
        .insert(audienceMembers)
        .values({
          orgId,
          audienceId,
          personId,
          source: c.provider,
          confidence: "provider_confirmed",
        })
        .onConflictDoUpdate({
          target: [audienceMembers.audienceId, audienceMembers.personId],
          set: { lastServedAt: sql`now()`, source: c.provider },
        });
    });
  }
}

// Re-snapshot per-provider counts for an audience via the free dry-run (apollo
// /search/dry-run + apify /search/count, zero credits). Fail loud on provider
// error. Returns the updated counts; persistence is the caller's job.
export async function refreshCounts(
  filters: PeopleSearchFilters,
  identity: Identity
): Promise<{ apolloCount: number; apifyCount: number; countedAt: Date }> {
  const [apollo, apify] = await Promise.all([
    dryRun({ provider: "apollo", filters, identity }),
    dryRun({ provider: "apify", filters, identity }),
  ]);
  return {
    apolloCount: apollo.totalEntries,
    apifyCount: apify.totalEntries,
    countedAt: new Date(),
  };
}

export interface AudienceStats {
  matched: Array<{
    personId: string;
    emailNorm: string | null;
    fullName: string | null;
    audiences: Array<{ audienceId: string; name: string }>;
  }>;
  unmatched: { emails: string[]; personIds: string[] };
  byAudience: Array<{
    audienceId: string;
    name: string;
    brandId: string;
    matchedCount: number;
  }>;
}

// Given a list of emails and/or personIds, resolve them to canonical people and
// return, per matched person, which audiences they belong to — plus a per-
// audience rollup of how many of the input people fall in it.
export async function computeStats(
  orgId: string,
  input: { emails?: string[]; personIds?: string[] }
): Promise<AudienceStats> {
  const emailNorms = [
    ...new Set(
      (input.emails ?? [])
        .map((e) => normalizeEmail(e))
        .filter((x): x is string => x !== null)
    ),
  ];
  const personIds = [...new Set(input.personIds ?? [])];

  // Resolve input identifiers to canonical people (scoped to the org).
  const idConds = [];
  if (emailNorms.length > 0)
    idConds.push(inArray(people.emailNorm, emailNorms));
  if (personIds.length > 0) idConds.push(inArray(people.id, personIds));

  const matchedPeople =
    idConds.length > 0
      ? await db
          .select({
            id: people.id,
            emailNorm: people.emailNorm,
            fullName: people.fullName,
          })
          .from(people)
          .where(and(eq(people.orgId, orgId), or(...idConds)))
      : [];

  const peopleById = new Map(matchedPeople.map((p) => [p.id, p]));
  const matchedIds = matchedPeople.map((p) => p.id);

  // Membership rows for the matched people, joined to their audiences.
  const memberships =
    matchedIds.length > 0
      ? await db
          .select({
            personId: audienceMembers.personId,
            audienceId: audiences.id,
            name: audiences.name,
            brandId: audiences.brandId,
          })
          .from(audienceMembers)
          .innerJoin(audiences, eq(audienceMembers.audienceId, audiences.id))
          .where(
            and(
              eq(audienceMembers.orgId, orgId),
              inArray(audienceMembers.personId, matchedIds)
            )
          )
      : [];

  const perPerson = new Map<
    string,
    Array<{ audienceId: string; name: string }>
  >();
  const perAudience = new Map<
    string,
    { audienceId: string; name: string; brandId: string; matchedCount: number }
  >();
  for (const m of memberships) {
    const list = perPerson.get(m.personId) ?? [];
    list.push({ audienceId: m.audienceId, name: m.name });
    perPerson.set(m.personId, list);

    const agg = perAudience.get(m.audienceId) ?? {
      audienceId: m.audienceId,
      name: m.name,
      brandId: m.brandId,
      matchedCount: 0,
    };
    agg.matchedCount += 1;
    perAudience.set(m.audienceId, agg);
  }

  const matched = matchedPeople.map((p) => ({
    personId: p.id,
    emailNorm: p.emailNorm,
    fullName: p.fullName,
    audiences: perPerson.get(p.id) ?? [],
  }));

  const matchedEmailSet = new Set(
    matchedPeople.map((p) => p.emailNorm).filter((x): x is string => x !== null)
  );
  const matchedIdSet = new Set(matchedIds);

  return {
    matched,
    unmatched: {
      emails: emailNorms.filter((e) => !matchedEmailSet.has(e)),
      personIds: personIds.filter((id) => !matchedIdSet.has(id)),
    },
    byAudience: [...perAudience.values()],
  };
}

// --- Audience suggestion (onboarding NL -> persisted candidate audiences) ---
//
// Two layers, then collapse + persist:
//
//   LAYER 1 (shared, provider-agnostic, ONE LLM call): decompose the caller's NL
//     into a SET of distinct named audiences { name, description }. The LLM reads
//     the caller's own granularity intent ("US and Europe separately", "split by
//     seniority", "one broad list"). The audience names are SHARED across both
//     providers so layer 2's two provider runs map to the SAME segments and can
//     be compared head-to-head.
//
//   LAYER 2 (per audience x per provider, an agentic multi-turn loop): hand the
//     segment + that provider's filter rulebook to the LLM, which proposes a
//     filter set ("test"), sees its FREE dry-run count fed back, and decides for
//     itself whether the count is a satisfying audience ("confirm"), needs more
//     refinement ("test" again), or is unreachable in scope ("exhausted").
//     Mirrors lead-service's generateNextStrategy self-iteration mechanism
//     (which is slated for deprecation later -- kept here for parity for now).
//
//   COLLAPSE: per audience, keep the provider with the larger count (tie ->
//     apollo). We return ONE candidate per audience, not one per provider.
//
//   PERSIST: each collapsed audience is written as an `audiences` row at status
//     "suggested" (INACTIVE -- never live for the brand until the caller flips it
//     to "active" via PATCH /orgs/audiences/{id}/status). We return the audience
//     ids so the front can activate the selected ones.
//
// No cost declared here -- chat-service meters the LLM spend; dry-run is free;
// the DB write is free. The cost invariant holds.

// APOLLO-ONLY (2026-06): apify removed from the suggest fan-out so /suggest no
// longer creates apify audiences. The collapse + best-provider logic below is
// unchanged (it just degenerates to a single provider). Restore by re-adding
// "apify" here. Existing apify audiences are migrated separately via
// POST /internal/migrate-apify-audiences-to-apollo.
const SUGGEST_PROVIDERS: Provider[] = ["apollo"];
const SUGGEST_MAX_CANDIDATES = 6; // cap on layer-1 audiences (not a knob)
const SUGGEST_MAX_ITERATION_ROUNDS = 8; // layer-2 agentic loop bound per (audience, provider)
const SUGGEST_STATUS = "suggested"; // inactive default for suggest-created rows

// LLM provider/model for the suggest flow. We use Gemini in SCHEMALESS JSON mode
// (responseMimeType: application/json, no responseSchema) rather than Anthropic:
// chat-service rejects anthropic JSON mode without a responseSchema, and
// Anthropic's strict schema requires `additionalProperties:false` + an explicit
// `properties` map on EVERY object -- which cannot express our open `filters`
// blob (~16 optional neutral fields) without enumerating + over-constraining it.
// Gemini's native JSON mode needs no schema, so the shape stays prompt-described
// + caller-validated.
//
// Model = `flash-pro` (Gemini 3.5 Flash, mid-tier). The whole relevance of a
// suggested audience is the LLM's NL->filters mapping -- apollo/apify just match
// structured filters deterministically, no LLM on their side -- so the model
// tier IS the filter-quality lever. `flash-pro` reasons over the segment +
// provider rulebook noticeably better than plain `flash` (which under-targets),
// while staying far cheaper than `pro`/`sonnet`.
const SUGGEST_LLM_PROVIDER = "google" as const;
const SUGGEST_LLM_MODEL = "flash-pro";

// Gemini structured-output schemas (passed as `responseSchema` so the provider
// ENFORCES the shape server-side → the response always parses, eliminating the
// schemaless-JSON "non-parsable → 502" failure that made /suggest flake ~50% of
// the time). These are GEMINI responseSchemas (a permissive OpenAPI subset) —
// NOT Anthropic strict schemas, so we don't enumerate `additionalProperties`.
// The open `filters` blob (#54's reason for going schemaless) IS expressible
// here: it's a fixed 16-field set. Values are still validated caller-side
// (PeopleSearchFiltersSchema in dryRunSafe / parseCandidates) — the schema
// guarantees valid JSON + the action enum, not semantic correctness.
//
// `disableThinking` is set on every suggest LLM call: structured JSON needs no
// chain-of-thought, and freeing the output budget also avoids truncated JSON.
const SUGGEST_DISABLE_THINKING = true;

const LAYER1_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    audiences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
        },
        required: ["name", "description"],
      },
    },
  },
  required: ["audiences"],
};

// The 16 neutral PeopleSearchFilters fields (mirrors src/schemas.ts) as a Gemini
// schema. All optional — the model populates only what this provider honors.
const FILTERS_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    titles: { type: "array", items: { type: "string" } },
    seniorities: { type: "array", items: { type: "string" } },
    functions: { type: "array", items: { type: "string" } },
    locationCountries: { type: "array", items: { type: "string" } },
    locationStates: { type: "array", items: { type: "string" } },
    locationCities: { type: "array", items: { type: "string" } },
    companyNames: { type: "array", items: { type: "string" } },
    companyDomains: { type: "array", items: { type: "string" } },
    industries: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
    employeeMin: { type: "integer" },
    employeeMax: { type: "integer" },
    companySizes: { type: "array", items: { type: "string" } },
    revenueRanges: { type: "array", items: { type: "string" } },
    fundingStages: { type: "array", items: { type: "string" } },
    technologies: { type: "array", items: { type: "string" } },
  },
};

// Layer-2 agentic action. `filters` only meaningful for action:"test", `reason`
// only for "exhausted" — both kept optional (Gemini has no clean discriminated
// union); parseLayer2Action handles the conditional caller-side.
const LAYER2_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["test", "confirm", "exhausted"] },
    filters: FILTERS_RESPONSE_SCHEMA,
    reasoning: { type: "string" },
    reason: { type: "string" },
  },
  required: ["action"],
};

const DESCRIPTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { description: { type: "string" } },
  required: ["description"],
};

export interface AudienceCandidate {
  audienceId: string;
  name: string;
  rationale: string;
  provider: Provider;
  filters: PeopleSearchFilters;
  count: number;
  status: string;
  validationError: string | null;
  truncated: boolean;
}

// --- Layer 1: decompose NL into named audiences ---

interface Segment {
  name: string;
  description: string;
}

const COUNTRY_ALIASES: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\b(?:us|u\.s\.|usa|u\.s\.a\.|united states|america)\b/i, value: "United States" },
  { pattern: /\bunited kingdom\b|\buk\b|\bu\.k\.\b/i, value: "United Kingdom" },
  { pattern: /\bfrance\b/i, value: "France" },
  { pattern: /\bgermany\b/i, value: "Germany" },
  { pattern: /\bcanada\b/i, value: "Canada" },
  { pattern: /\baustralia\b/i, value: "Australia" },
  { pattern: /\bspain\b/i, value: "Spain" },
  { pattern: /\bitaly\b/i, value: "Italy" },
  { pattern: /\bnetherlands\b/i, value: "Netherlands" },
];

const INDUSTRY_ALIASES: Array<{ pattern: RegExp; names: string[] }> = [
  { pattern: /\b(?:software|saas|b2b software)\b/i, names: ["Computer Software", "Software", "Information Technology & Services"] },
  { pattern: /\bprofessional services?\b/i, names: ["Professional Services"] },
  { pattern: /\bconsult(?:ing|ancies|ants?)\b/i, names: ["Management Consulting", "Professional Services"] },
  { pattern: /\bfintech\b|\bfinancial services?\b/i, names: ["Financial Services", "Banking"] },
  { pattern: /\bmarketing agenc(?:y|ies)\b|\badvertising agenc(?:y|ies)\b/i, names: ["Marketing & Advertising"] },
  { pattern: /\be-?commerce\b|\becommerce\b/i, names: ["Internet", "Retail"] },
];

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

function mergeStringArrays(a?: string[], b?: string[]): string[] | undefined {
  const merged = uniqueStrings([...(a ?? []), ...(b ?? [])]);
  return merged.length > 0 ? merged : undefined;
}

function mergeFilters(
  base: PeopleSearchFilters,
  required: PeopleSearchFilters
): PeopleSearchFilters {
  return {
    ...base,
    titles: mergeStringArrays(base.titles, required.titles),
    seniorities: mergeStringArrays(base.seniorities, required.seniorities),
    functions: mergeStringArrays(base.functions, required.functions),
    locationCountries: mergeStringArrays(
      base.locationCountries,
      required.locationCountries
    ),
    locationStates: mergeStringArrays(base.locationStates, required.locationStates),
    locationCities: mergeStringArrays(base.locationCities, required.locationCities),
    companyNames: mergeStringArrays(base.companyNames, required.companyNames),
    companyDomains: mergeStringArrays(base.companyDomains, required.companyDomains),
    industries: mergeStringArrays(base.industries, required.industries),
    keywords: mergeStringArrays(base.keywords, required.keywords),
    companySizes: mergeStringArrays(base.companySizes, required.companySizes),
    revenueRanges: mergeStringArrays(base.revenueRanges, required.revenueRanges),
    fundingStages: mergeStringArrays(base.fundingStages, required.fundingStages),
    technologies: mergeStringArrays(base.technologies, required.technologies),
    employeeMin: required.employeeMin ?? base.employeeMin,
    employeeMax: required.employeeMax ?? base.employeeMax,
  };
}

function compactNumber(raw: string, unit?: string): number {
  const n = Number(raw.replace(/,/g, ""));
  const u = unit?.toLowerCase();
  if (u === "k" || u === "thousand") return Math.round(n * 1_000);
  if (u === "m" || u === "mm" || u === "million") return Math.round(n * 1_000_000);
  if (u === "b" || u === "bn" || u === "billion") return Math.round(n * 1_000_000_000);
  return Math.round(n);
}

function extractEmployeeRange(text: string): Pick<PeopleSearchFilters, "employeeMin" | "employeeMax"> {
  const m = text.match(
    /\b(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?\s*(?:-|to|through|and)\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?\s*(?:employees?|people|headcount)\b/i
  );
  if (!m) return {};
  const maxUnit = m[4];
  const min = compactNumber(m[1], m[2] ?? maxUnit);
  const max = compactNumber(m[3], maxUnit);
  return min > 0 && max >= min ? { employeeMin: min, employeeMax: max } : {};
}

function extractRevenueRanges(text: string): string[] {
  const re =
    /\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|mm|b|bn|thousand|million|billion)?\s*(?:-|to|through|and)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|mm|b|bn|thousand|million|billion)?\s*(?:\/?\s*(?:yr|year|annum)|annual(?:ly)?|revenue|arr|sales)?/gi;
  const matches = [...text.matchAll(re)];
  const m = matches.find((match) => {
    const matched = match[0];
    return /\$|\/?\s*(?:yr|year|annum)|annual(?:ly)?|revenue|arr|sales/i.test(
      matched
    );
  });
  if (!m) return [];
  const maxUnit = m[4];
  const min = compactNumber(m[1], m[2] ?? maxUnit);
  const max = compactNumber(m[3], maxUnit);
  if (min <= 0 || max < min) return [];
  return [`${min},${max}`];
}

function findCanonicalIndustry(
  vocab: string[],
  names: string[]
): string | null {
  const byLower = new Map(vocab.map((v) => [v.toLowerCase(), v]));
  for (const name of names) {
    const exact = byLower.get(name.toLowerCase());
    if (exact) return exact;
  }
  for (const name of names) {
    const needle = name.toLowerCase();
    const contains = vocab.find((v) => v.toLowerCase().includes(needle));
    if (contains) return contains;
  }
  return null;
}

function extractSupportedConstraints(args: {
  text: string;
  industriesVocab?: string[];
}): PeopleSearchFilters {
  const filters: PeopleSearchFilters = {
    ...extractEmployeeRange(args.text),
  };

  const revenueRanges = extractRevenueRanges(args.text);
  if (revenueRanges.length > 0) filters.revenueRanges = revenueRanges;

  const locationCountries = COUNTRY_ALIASES
    .filter((alias) => alias.pattern.test(args.text))
    .map((alias) => alias.value);
  if (locationCountries.length > 0) {
    filters.locationCountries = uniqueStrings(locationCountries);
  }

  if (args.industriesVocab && args.industriesVocab.length > 0) {
    const industries = INDUSTRY_ALIASES
      .filter((alias) => alias.pattern.test(args.text))
      .map((alias) => findCanonicalIndustry(args.industriesVocab ?? [], alias.names))
      .filter((x): x is string => x !== null);
    if (industries.length > 0) filters.industries = uniqueStrings(industries);
  }

  const keywords: string[] = [];
  if (/\bb2b\b/i.test(args.text)) keywords.push("B2B");
  if (/\bbasic crm tools?\b/i.test(args.text)) keywords.push("basic CRM tools");
  if (/\bspreadsheets?\b/i.test(args.text)) keywords.push("spreadsheets");
  if (keywords.length > 0) filters.keywords = uniqueStrings(keywords);

  return filters;
}

function buildLayer1SystemPrompt(): string {
  return [
    "You decompose a natural-language audience request into a SET of distinct,",
    "named target audiences. PROACTIVELY split a heterogeneous request into one",
    "audience per clearly-distinct facet -- you do NOT need the caller to write",
    '"separately" or "split by". A facet is distinct when the request spans more',
    "than one value on any ICP axis below: different PERSONAS (e.g. founders AND",
    "marketing-agency owners AND heads of growth), different GEOGRAPHIES (e.g. US",
    "AND France AND Germany), different INDUSTRIES (e.g. SaaS AND e-commerce), or",
    "different COMPANY TYPES (e.g. early-stage startups AND enterprises). Each",
    "such facet becomes its OWN audience -- because each maps to a different",
    "people-search filter set. If the caller is explicit about grouping",
    '("US and Europe separately", "one broad list"), honor that intent exactly.',
    "",
    "BUT do NOT over-split a genuinely COHESIVE request. A single persona in a",
    "single geography/industry (e.g. \"founders of B2B SaaS startups in the US\")",
    "is ONE audience -- splitting it into noise (e.g. by arbitrary sub-titles or",
    "company sizes the caller never mentioned) is wrong. Split only on axes the",
    "caller actually spans; never invent a grouping dimension.",
    `Never produce more than ${SUGGEST_MAX_CANDIDATES} audiences -- if the request`,
    "spans more distinct facets than that, group the closest ones coarser.",
    "",
    "An ICP (ideal customer profile) for a people-search database is defined by",
    "THREE filterable axes -- make each audience concrete on the axes the caller",
    "implies, and DO NOT invent constraints they didn't state:",
    "  1. PERSONA (the person): job titles, seniority level, department/function.",
    "  2. FIRMOGRAPHIC (the company): industry, headcount/size, revenue, funding",
    "     stage, and geography (where the person or the company HQ is).",
    "  3. TECHNOGRAPHIC (optional): technologies the company uses -- only when the",
    "     caller mentions a tool/stack.",
    "",
    "Each audience needs:",
    '- "name": a short human label, MAX 4 words (e.g. "CEO SaaS US >$1M",',
    '  "Security-First Enterprise Tech"). Distinct per audience.',
    '- "description": ONE self-contained sentence that pins down the audience on',
    "  the relevant axes above (persona + firmographic, plus technographic/geo",
    "  when implied) -- concrete and detailed enough to build people-search filters",
    "  from without re-reading the original request. Carry over EVERY constraint",
    "  the caller stated; never drop or invent one.",
    "",
    "Respond with ONLY valid JSON (no prose, no markdown):",
    '{"audiences":[{"name":"<=4 words","description":"one sentence"}]}',
  ].join("\n");
}

function parseSegments(obj: Record<string, unknown>): Segment[] {
  const arr = obj.audiences;
  if (!Array.isArray(arr)) {
    throw new ChatServiceError(502, "LLM response missing `audiences` array");
  }
  return arr.map((c, i) => {
    if (!c || typeof c !== "object") {
      throw new ChatServiceError(502, `LLM audience ${i} is not an object`);
    }
    const o = c as Record<string, unknown>;
    if (typeof o.name !== "string" || o.name.length === 0) {
      throw new ChatServiceError(502, `LLM audience ${i} missing name`);
    }
    if (typeof o.description !== "string" || o.description.length === 0) {
      throw new ChatServiceError(502, `LLM audience ${i} missing description`);
    }
    return { name: o.name, description: o.description };
  });
}

async function decomposeSegments(
  nlPrompt: string,
  identity: Identity
): Promise<{ segments: Segment[]; truncated: boolean }> {
  const parsed = parseSegments(
    await completeJson({
      message: nlPrompt,
      systemPrompt: buildLayer1SystemPrompt(),
      identity,
      provider: SUGGEST_LLM_PROVIDER,
      model: SUGGEST_LLM_MODEL,
      responseSchema: LAYER1_RESPONSE_SCHEMA,
      disableThinking: SUGGEST_DISABLE_THINKING,
    })
  );
  const truncated = parsed.length > SUGGEST_MAX_CANDIDATES;
  return { segments: parsed.slice(0, SUGGEST_MAX_CANDIDATES), truncated };
}

// --- Backfill: one-sentence description from an audience's own name + filters ---

// A row whose LLM generation produced no usable description. The backfill route
// treats this as a per-row skip (logged, retried on re-run) — NOT a fatal sweep
// error (that is reserved for a chat-service outage / missing config).
export class AudienceDescriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudienceDescriptionError";
  }
}

function buildDescriptionSystemPrompt(): string {
  return [
    "You write a SINGLE concise sentence describing who a B2B people-search",
    "audience targets, derived ONLY from its name and its structured filters.",
    "The sentence pins down the persona (titles / seniority / function) and the",
    "firmographic + geographic constraints the filters encode -- present tense,",
    "at most 30 words, no preamble, no trailing notes. Do NOT invent any",
    "constraint that is not in the filters, and do NOT restate the raw JSON. If",
    "the filters are sparse, describe honestly what little they encode.",
    "",
    "Respond with ONLY valid JSON (no prose, no markdown):",
    '{"description":"<one sentence>"}',
  ].join("\n");
}

// Generate the per-audience description used by the dashboard "Described as"
// line, from the row's OWN name + filters (NEVER the shared batch nlPrompt).
// Runs via chat-service's ORG-LESS platform path (platformCompleteJson) so a
// historical backfill does not bill users' orgs; chat-service owns the cost.
// Same Gemini schemaless-JSON setup the /suggest layer-1 uses.
export async function generateAudienceDescription(args: {
  name: string;
  filters: unknown;
}): Promise<string> {
  const message = [
    `Audience name: ${JSON.stringify(args.name)}`,
    "Filters (neutral PeopleSearchFilters JSON):",
    JSON.stringify(args.filters ?? {}),
  ].join("\n");
  const json = await platformCompleteJson({
    message,
    systemPrompt: buildDescriptionSystemPrompt(),
    provider: SUGGEST_LLM_PROVIDER,
    model: SUGGEST_LLM_MODEL,
    responseSchema: DESCRIPTION_RESPONSE_SCHEMA,
    disableThinking: SUGGEST_DISABLE_THINKING,
  });
  const description = json.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new AudienceDescriptionError(
      "LLM response missing a non-empty `description`"
    );
  }
  return description.trim();
}

// --- Layer 2: per (audience, provider) agentic filter-refinement loop ---

// Count a filter set via the FREE dry-run. A provider 4xx means the filters are
// invalid (LLM's fault -> feed back to revise); a 5xx / network / config error is
// a real outage -> rethrow (fail loud). NOT a swallow: the 4xx IS the validation
// signal the loop consumes.
async function dryRunSafe(
  provider: Provider,
  filters: PeopleSearchFilters,
  identity: Identity
): Promise<{ count: number; validationError: string | null }> {
  // The LLM proposes the filter shape blind; validate it against the neutral
  // filters schema BEFORE the provider call. A bad shape (e.g. `keywords` as a
  // string instead of string[], or a non-enum seniority) is the LLM's fault and
  // is fed back into the loop via the SAME validationError channel as a provider
  // 4xx -- never a crash, never a silent coercion.
  const parsed = PeopleSearchFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { count: 0, validationError: `Invalid filter shape: ${issues}` };
  }
  try {
    const { totalEntries } = await dryRun({
      provider,
      filters: parsed.data,
      identity,
    });
    return { count: totalEntries, validationError: null };
  } catch (err) {
    if (err instanceof ProviderError && err.status >= 400 && err.status < 500) {
      return { count: 0, validationError: err.message };
    }
    throw err;
  }
}

function buildLayer2SystemPrompt(
  provider: Provider,
  rules: string,
  industriesVocab?: string[]
): string {
  return [
    `You build a ${provider} people-search audience for ONE target segment.`,
    "",
    "PROVIDER FILTER RULES (authoritative -- only these values are valid):",
    rules,
    "",
    'Your "filters" MUST use ONLY these neutral fields (omit any you don\'t use):',
    "titles[], seniorities[] (one of: entry, senior, manager, director, vp,",
    "c_suite, owner, founder, partner), functions[], locationCountries[],",
    "locationStates[], locationCities[], companyNames[], companyDomains[],",
    "industries[], keywords[], employeeMin (int), employeeMax (int),",
    "companySizes[], revenueRanges[], fundingStages[], technologies[].",
    "Populate the fields THIS provider honors best per the rules above.",
    "",
    "VOCABULARY IS EXACT. For any enum-constrained field (seniorities, functions,",
    "industries, companySizes, revenueRanges, fundingStages) use ONLY values that",
    "appear verbatim in the rules / lists above -- copy them character-for-",
    "character. NEVER invent or paraphrase an enum value (e.g. do not write 'SaaS'",
    "or 'Tech' for an industry): an unrecognized value is silently dropped by the",
    "provider and quietly under-matches. Free-text fields (titles, keywords,",
    "locations, companyNames, companyDomains, technologies) accept any string.",
    ...(industriesVocab && industriesVocab.length > 0
      ? [
          "",
          "CANONICAL INDUSTRIES (the ONLY accepted values for industries[] -- pick",
          "the closest one or more; do not use any industry name not in this list):",
          industriesVocab.join(", ") + ".",
        ]
      : []),
    "",
    "You operate in a MULTI-TURN loop. Each turn respond with EXACTLY ONE JSON",
    "object (no prose, no markdown):",
    '- TEST a filter set (server replies with its live match count):',
    '  {"action":"test","filters":{ ... },"reasoning":"<one sentence>"}',
    "- CONFIRM the last tested set when you are SATISFIED its count is a healthy,",
    '  well-targeted audience for this segment: {"action":"confirm","reasoning":"..."}',
    '- EXHAUSTED if no valid in-scope filter set yields a usable audience:',
    '  {"action":"exhausted","reason":"<why>"}',
    "",
    "JUDGE THE COUNT YOURSELF: aim for a focused, addressable audience -- roughly",
    "500 to 50,000 people is a healthy band for a B2B segment. Far below ~200 is",
    "too narrow (a typo'd title, an over-constrained set, or a dropped enum value)",
    "-> broaden or fix the vocabulary and test again. In the hundreds-of-thousands",
    "or millions is too loose (under-targeted) -> add a discriminating constraint",
    "and test again. A count inside the band that faithfully matches the segment",
    "-> confirm. These are guides, not hard limits: a genuinely niche segment may",
    "legitimately sit under 200 -- confirm it rather than widening beyond scope.",
    "Iterate as many test rounds as you need before confirming. Stay STRICTLY",
    "within the segment description -- never widen beyond its titles/geography/",
    "company traits. If a test returns a validation error, propose corrected",
    "filters; NEVER confirm a set with unresolved validation errors.",
  ].join("\n");
}

interface RefineResult {
  filters: PeopleSearchFilters;
  count: number;
  validationError: string | null;
}

type Layer2Action =
  | { type: "test"; filters: PeopleSearchFilters }
  | { type: "confirm" }
  | { type: "exhausted"; reason: string }
  | { type: "unknown" };

function parseLayer2Action(obj: Record<string, unknown>): Layer2Action {
  const action = typeof obj.action === "string" ? obj.action : "";
  if (action === "exhausted") {
    return {
      type: "exhausted",
      reason:
        typeof obj.reason === "string"
          ? obj.reason
          : "LLM declared exhausted with no reason",
    };
  }
  if (action === "confirm") return { type: "confirm" };
  if (action === "test") {
    if (
      obj.filters &&
      typeof obj.filters === "object" &&
      !Array.isArray(obj.filters)
    ) {
      return { type: "test", filters: obj.filters as PeopleSearchFilters };
    }
  }
  return { type: "unknown" };
}

async function refineFilters(
  provider: Provider,
  segment: Segment,
  requestText: string,
  identity: Identity,
  // When true, route the layer-2 LLM calls through chat-service's ORG-LESS
  // platform path (platformCompleteJson) instead of the org-billed /complete.
  // Used by the apify→apollo migration: re-deriving filters for a migration we
  // owe users must NOT bill their orgs (same rationale as the description
  // backfill). The apollo dry-run / filters-prompt / industries calls STILL use
  // `identity` (apollo needs org+user for key resolution) — only the LLM is
  // platform-routed. Default false (the /suggest flow bills the org as before).
  opts: { usePlatformLLM?: boolean } = {}
): Promise<RefineResult> {
  const rules = (await filtersPrompt({ provider, identity })).prompt;
  // apollo's industries filter is free-text against a hidden canonical taxonomy;
  // inject the authoritative list so the LLM can only pick matchable values.
  // apify already embeds its accepted values in its own filters-prompt.
  const industriesVocab =
    provider === "apollo"
      ? await apolloIndustriesReference({ identity })
      : undefined;
  const requiredFilters = extractSupportedConstraints({
    text: `${requestText}\n${segment.description}`,
    industriesVocab,
  });
  const systemPrompt = buildLayer2SystemPrompt(provider, rules, industriesVocab);
  const transcript: string[] = [
    [
      "TARGET AUDIENCE:",
      `name: ${segment.name}`,
      `description: ${segment.description}`,
      Object.keys(requiredFilters).length > 0
        ? [
            "",
            "LOCKED EXPLICIT FILTERS:",
            JSON.stringify(requiredFilters),
            "These constraints came from the user's request and MUST remain in every tested filter set.",
          ].join("\n")
        : "",
      "",
      `Propose your first "test" filter set for ${provider}.`,
    ].join("\n"),
  ];

  let lastFilters: PeopleSearchFilters | null = null;
  let lastCleanCount = 0; // count of the last test that had NO validation error
  let lastValidationError: string | null = null;
  let lastHadError = false;

  for (let round = 0; round < SUGGEST_MAX_ITERATION_ROUNDS; round++) {
    const llmArgs = {
      message: transcript.join("\n\n---\n\n"),
      systemPrompt,
      provider: SUGGEST_LLM_PROVIDER,
      model: SUGGEST_LLM_MODEL,
      responseSchema: LAYER2_RESPONSE_SCHEMA,
      disableThinking: SUGGEST_DISABLE_THINKING,
    };
    const action = parseLayer2Action(
      opts.usePlatformLLM
        ? await platformCompleteJson(llmArgs)
        : await completeJson({ ...llmArgs, identity })
    );

    if (action.type === "exhausted") {
      // Best-effort: if a clean filter set was tested before giving up, return it
      // (honest count); otherwise surface count 0 + the reason.
      if (lastFilters && !lastHadError) {
        return {
          filters: lastFilters,
          count: lastCleanCount,
          validationError: null,
        };
      }
      return {
        filters: lastFilters ?? {},
        count: 0,
        validationError: lastValidationError ?? action.reason,
      };
    }

    if (action.type === "confirm") {
      if (!lastFilters || lastHadError) {
        transcript.push(
          `Round ${round + 1}: confirm rejected -- you must TEST a valid filter set (no validation errors) before confirming.`
        );
        continue;
      }
      return {
        filters: lastFilters,
        count: lastCleanCount,
        validationError: null,
      };
    }

    if (action.type === "test") {
      const filters = mergeFilters(action.filters, requiredFilters);
      const r = await dryRunSafe(provider, filters, identity);
      lastFilters = filters;
      if (r.validationError) {
        lastHadError = true;
        lastValidationError = r.validationError;
        transcript.push(
          `Round ${round + 1}: filters=${JSON.stringify(filters)} -> REJECTED as invalid: ${r.validationError}. Propose corrected filters, or declare exhausted.`
        );
      } else {
        lastHadError = false;
        lastValidationError = null;
        lastCleanCount = r.count;
        transcript.push(
          `Round ${round + 1}: filters=${JSON.stringify(filters)} -> count=${r.count}. Confirm this set, test another, or declare exhausted.`
        );
      }
      continue;
    }

    transcript.push(
      `Round ${round + 1}: unrecognized response. Reply with exactly one JSON action: test, confirm, or exhausted.`
    );
  }

  // Iteration budget exhausted -- return the best clean effort, else honest 0.
  if (lastFilters && !lastHadError) {
    return { filters: lastFilters, count: lastCleanCount, validationError: null };
  }
  return { filters: lastFilters ?? {}, count: 0, validationError: lastValidationError };
}

// --- Persist a collapsed audience at status "suggested" (inactive) ---
//
// Unique per (org_id, brand_id, lower(name)). On a name collision: refresh the
// filters/count ONLY when the existing row is still "suggested"; NEVER mutate an
// active/paused/archived audience (audiences are immutable except their status).
// Returns the audience id either way.
async function persistSuggestedAudience(args: {
  identity: Identity;
  brandId: string;
  nlPrompt: string;
  segment: Segment;
  provider: Provider;
  filters: PeopleSearchFilters;
  count: number;
}): Promise<string> {
  const orgId = args.identity.orgId;
  const countCols =
    args.provider === "apollo"
      ? { apolloCount: args.count }
      : { apifyCount: args.count };
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(audiences)
      .where(
        and(
          eq(audiences.orgId, orgId),
          eq(audiences.brandId, args.brandId),
          sql`lower(${audiences.name}) = lower(${args.segment.name})`
        )
      )
      .limit(1);

    if (existing) {
      if (existing.status === SUGGEST_STATUS) {
        await tx
          .update(audiences)
          .set({
            provider: args.provider,
            filters: args.filters as Record<string, unknown>,
            ...countCols,
            countedAt: new Date(),
            nlPrompt: args.nlPrompt,
            description: args.segment.description,
            updatedAt: new Date(),
          })
          .where(eq(audiences.id, existing.id));
      }
      return existing.id;
    }

    const [row] = await tx
      .insert(audiences)
      .values({
        orgId,
        brandId: args.brandId,
        name: args.segment.name,
        nlPrompt: args.nlPrompt,
        description: args.segment.description,
        provider: args.provider,
        status: SUGGEST_STATUS,
        filters: args.filters as Record<string, unknown>,
        ...countCols,
        countedAt: new Date(),
        createdByUserId: args.identity.userId ?? null,
      })
      .returning({ id: audiences.id });
    return row.id;
  });
}

// Turn a natural-language prompt into a set of PERSISTED candidate audiences.
// Layer 1 decomposes the NL into named segments; layer 2 builds + refines each
// segment's filters per provider (agentic loop); we collapse to the higher-count
// provider per segment and persist each at status "suggested" (inactive). Fail
// loud: a provider/chat outage propagates (502). The caller activates chosen ids
// via PATCH /orgs/audiences/{id}/status.
export async function suggestAudiences(
  nlPrompt: string,
  brandId: string,
  identity: Identity
): Promise<AudienceCandidate[]> {
  const { segments, truncated } = await decomposeSegments(nlPrompt, identity);

  // Layer 2 + collapse, per segment. Segments run concurrently; the two providers
  // within a segment run concurrently too. Both fan-outs are FAULT-TOLERANT
  // (allSettled): one provider's outage doesn't drop the other's good result for
  // that segment, and one segment's total failure doesn't nuke the whole batch.
  // We still FAIL LOUD when there's nothing to return — if every segment failed,
  // the first error propagates (502) rather than a misleading empty success.
  const settled = await Promise.allSettled(
    segments.map(async (segment) => {
      const perProviderSettled = await Promise.allSettled(
        SUGGEST_PROVIDERS.map(async (provider) => ({
          provider,
          ...(await refineFilters(provider, segment, nlPrompt, identity)),
        }))
      );
      const perProvider = perProviderSettled
        .filter((r): r is PromiseFulfilledResult<{ provider: Provider } & RefineResult> =>
          r.status === "fulfilled"
        )
        .map((r) => r.value);
      // Both providers errored for this segment — surface it (the segment fails;
      // the outer allSettled keeps the other segments).
      if (perProvider.length === 0) {
        throw (perProviderSettled.find((r) => r.status === "rejected") as
          | PromiseRejectedResult
          | undefined)?.reason ?? new Error("both providers failed");
      }
      // Pick the larger count; reduce keeps the incumbent on a tie, and apollo is
      // first in SUGGEST_PROVIDERS, so (when both succeeded) ties resolve to apollo.
      const winner = perProvider.reduce((best, cur) =>
        cur.count > best.count ? cur : best
      );
      return { segment, winner };
    })
  );

  const collapsed = settled
    .filter(
      (
        r
      ): r is PromiseFulfilledResult<{
        segment: Segment;
        winner: { provider: Provider } & RefineResult;
      }> => r.status === "fulfilled"
    )
    .map((r) => r.value);

  const failures = settled.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected"
  );
  if (failures.length > 0) {
    console.error(
      `[human-service] audience.suggest partial: ${failures.length}/${segments.length} segment(s) failed`,
      failures[0].reason
    );
  }
  // Nothing survived — fail loud with the first underlying error.
  if (collapsed.length === 0 && segments.length > 0) {
    throw failures[0]?.reason ?? new ChatServiceError(502, "all segments failed");
  }

  // Persist sequentially (one row per segment; names are distinct, so no
  // intra-request collision; the unique index guards cross-request races).
  const out: AudienceCandidate[] = [];
  for (const { segment, winner } of collapsed) {
    const audienceId = await persistSuggestedAudience({
      identity,
      brandId,
      nlPrompt,
      segment,
      provider: winner.provider,
      filters: winner.filters,
      count: winner.count,
    });
    out.push({
      audienceId,
      name: segment.name,
      rationale: segment.description,
      provider: winner.provider,
      filters: winner.filters,
      count: winner.count,
      status: SUGGEST_STATUS,
      validationError: winner.validationError,
      truncated,
    });
  }
  return out;
}

// --- apify→apollo migration (one-time) ---

// Provenance tag on the apollo audiences created by the migration, for
// reversibility (DELETE WHERE source=this + un-deprecate the apify rows).
export const MIGRATED_FROM_APIFY_SOURCE = "migrated_from_apify";

export interface ApifyToApolloMigrationResult {
  apifyAudienceId: string;
  apolloAudienceId: string;
  name: string;
  status: string;
  apolloCount: number;
}

// Re-derive an equivalent APOLLO audience for one apify audience and retire the
// apify one. The apify filters are NOT copied — each provider's layer-2 loop
// tunes the neutral filter set differently (esp. apollo `industries`, a hidden
// LinkedIn taxonomy vs apify free-text), so we re-run the agentic refine FOR
// apollo (LLM via the platform path — no org bill; apollo dry-runs via the
// audience's own creator identity). Then, atomically: deprecate + rename the
// apify row (freeing the unique name) and insert a new apollo audience that
// MIRRORS the source status (an active apify audience becomes an active apollo
// one; a suggested one stays suggested). Returns null when apollo refinement
// yields no usable filter set — the caller logs + skips, leaving the apify row
// untouched (retried on re-run).
export async function migrateApifyAudienceToApollo(
  row: typeof audiences.$inferSelect
): Promise<ApifyToApolloMigrationResult | null> {
  const identity: Identity = {
    orgId: row.orgId,
    userId: row.createdByUserId ?? undefined,
  };
  const segment: Segment = {
    name: row.name,
    description: row.description ?? row.name,
  };
  const refined = await refineFilters(
    "apollo",
    segment,
    row.nlPrompt ?? row.description ?? row.name,
    identity,
    { usePlatformLLM: true }
  );
  if (!refined.filters || Object.keys(refined.filters).length === 0) {
    return null;
  }

  return db.transaction(async (tx) => {
    // Rename + deprecate the apify row FIRST so the original name is free for the
    // new apollo audience (the unique index is on (org, brand, lower(name))).
    await tx
      .update(audiences)
      .set({
        name: `${row.name} [Apify]`,
        status: "deprecated",
        updatedAt: new Date(),
      })
      .where(eq(audiences.id, row.id));

    const [apollo] = await tx
      .insert(audiences)
      .values({
        orgId: row.orgId,
        brandId: row.brandId,
        name: row.name,
        nlPrompt: row.nlPrompt,
        description: row.description,
        provider: "apollo",
        status: row.status,
        source: MIGRATED_FROM_APIFY_SOURCE,
        filters: refined.filters as Record<string, unknown>,
        apolloCount: refined.count,
        countedAt: new Date(),
        createdByUserId: row.createdByUserId,
      })
      .returning({ id: audiences.id });

    return {
      apifyAudienceId: row.id,
      apolloAudienceId: apollo.id,
      name: row.name,
      status: row.status,
      apolloCount: refined.count,
    };
  });
}

// Verify an audience exists and belongs to the org. Returns the row or null.
export async function getAudienceInOrg(
  orgId: string,
  audienceId: string
): Promise<typeof audiences.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(audiences)
    .where(and(eq(audiences.id, audienceId), eq(audiences.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

// Thrown when an audience cannot serve people because it lacks the stored state
// serve-next needs (a committed provider, or a non-empty filter set). Fail loud
// (route → 422) rather than silently returning an empty / wrong result.
export class AudienceNotServableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudienceNotServableError";
  }
}

export interface ServeNextResult {
  status: "served" | "exhausted";
  person: Person | null;
}

// Serve the NEXT unserved person of an audience — the per-iteration lead
// primitive lead-service calls. A thin wrapper over the existing people-gateway
// machinery: it searches with the audience's STORED canonical filters via its
// committed provider, scoped to the audience's brand so the per-brand cross-
// provider suppression excludes anyone already served (the no-repeat guarantee),
// records the serve, tags audience membership, and signals exhaustion cleanly.
//
// The caller (route) MUST pass identity.brandIds = [audience.brandId] — that is
// what drives suppression. The audience is assumed already org-validated.
export async function serveNextPerson(
  audience: typeof audiences.$inferSelect,
  identity: Identity
): Promise<ServeNextResult> {
  const provider = audience.provider;
  if (provider !== "apollo" && provider !== "apify") {
    throw new AudienceNotServableError(
      "Audience has no committed provider — cannot serve people."
    );
  }
  const filters = (audience.filters ?? null) as PeopleSearchFilters | null;
  if (!filters || Object.keys(filters).length === 0) {
    throw new AudienceNotServableError(
      "Audience has no stored filters — cannot serve people."
    );
  }

  if (provider === "apify") {
    // apify BILLS per returned lead and pushes the brand exclude-set down, so a
    // single hit is already an unserved, suppression-recorded serve. limit 1.
    const result = await peopleSearch({
      provider: "apify",
      filters,
      limit: 1,
      audienceId: audience.id,
      identity,
    });
    const person = result.people[0] ?? null;
    if (!person) return { status: "exhausted", person: null };
    await tagAudienceServe(identity.orgId, audience.id, [
      toServedContact(person),
    ]);
    return { status: "served", person };
  }

  // apollo: search is a FREE teaser list (already suppression-filtered + bounded
  // by the saturation stop). Enrich teasers one at a time until one reveals a
  // non-suppressed person (the billed reveal records the serve in finalizeResolved),
  // then stop. All teasers exhausted / saturated ⟹ no fresh person.
  const search = await peopleSearch({
    provider: "apollo",
    filters,
    audienceId: audience.id,
    identity,
  });
  for (const teaser of search.people) {
    if (!teaser.providerPersonId) continue;
    const revealed = await resolveEmail({
      provider: "apollo",
      providerPersonId: teaser.providerPersonId,
      audienceId: audience.id,
      identity,
    });
    if (revealed.person) {
      await tagAudienceServe(identity.orgId, audience.id, [
        toServedContact(revealed.person),
      ]);
      return { status: "served", person: revealed.person };
    }
  }
  return { status: "exhausted", person: null };
}

// --- Avatar style: flat-vector character on a distinctive colour ------------
//
// Audiences used to render as a "photorealistic headshot" → the image model
// collapsed every persona to the same generic person-in-a-suit, impossible to
// tell apart. Instead we render a FLAT VECTOR character with role-symbolising
// props on a BOLD solid background, and we pick three separable axes
// DETERMINISTICALLY from the audience id — background colour, gender, age band —
// so (a) each audience keeps a stable look across regenerations, and (b) the set
// spreads across colours/appearances and is easy to differentiate at a glance.

// Bold, high-contrast solid background colours spread around the hue wheel.
const AVATAR_BG_PALETTE = [
  "teal",
  "coral",
  "indigo",
  "amber yellow",
  "magenta",
  "emerald green",
  "crimson red",
  "royal blue",
  "bright orange",
  "violet purple",
  "lime green",
  "deep pink",
  "turquoise",
  "golden yellow",
  "slate blue",
  "tomato red",
] as const;

// Appearance axes — break the "default man in a suit" while staying stable and
// diverse across the audience set (each axis seeded independently from the id so
// colour/gender/age don't correlate).
const AVATAR_GENDERS = ["a woman", "a man", "a non-binary person"] as const;
const AVATAR_AGES = [
  "in their late 20s",
  "in their 30s",
  "in their 40s",
  "in their 50s",
] as const;

// FNV-1a 32-bit hash → stable, well-distributed index from a uuid string.
function hashIndex(seed: string, modulo: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % modulo;
}

// The audience's stable background colour — the primary separability lever.
export function pickAvatarPalette(id: string): string {
  return AVATAR_BG_PALETTE[hashIndex(id, AVATAR_BG_PALETTE.length)];
}

// Build the default image prompt from the audience's own descriptors, so the
// generated avatar visually represents the persona the filters target — as a
// unique, iconic flat-vector character rather than an interchangeable headshot.
export function buildAvatarPrompt(
  audience: typeof audiences.$inferSelect
): string {
  const bg = pickAvatarPalette(audience.id);
  const gender =
    AVATAR_GENDERS[hashIndex(`${audience.id}:gender`, AVATAR_GENDERS.length)];
  const age = AVATAR_AGES[hashIndex(`${audience.id}:age`, AVATAR_AGES.length)];

  const f = (audience.filters ?? {}) as PeopleSearchFilters;
  const traits: string[] = [];
  if (f.titles?.length) traits.push(`role/titles: ${f.titles.slice(0, 3).join(", ")}`);
  if (f.seniorities?.length) traits.push(`seniority: ${f.seniorities.slice(0, 3).join(", ")}`);
  if (f.industries?.length) traits.push(`industry: ${f.industries.slice(0, 3).join(", ")}`);
  if (f.functions?.length) traits.push(`function: ${f.functions.slice(0, 3).join(", ")}`);

  const descriptor = audience.description ?? audience.nlPrompt ?? audience.name;

  const parts = [
    `Flat vector illustration avatar representing the B2B buyer persona "${audience.name}".`,
    `Persona: ${descriptor}.`,
  ];
  if (traits.length) parts.push(`Persona traits — ${traits.join("; ")}.`);
  parts.push(
    `Depict ${gender} ${age} as a friendly character, bust framing, centered, holding or surrounded by 1-2 simple objects that symbolise their role / industry. Diverse, modern, approachable.`,
    `Bold SINGLE solid ${bg} background. Thick clean outlines, simple geometric shapes, modern corporate vector illustration, high contrast.`,
    `Square 1:1 composition. No photorealism, no text, no logos, no letters.`
  );
  return parts.join(" ");
}

// (Re)generate an audience's avatar: delegate image generation to chat-service
// (which owns the cost), store the bytes as a self-contained data: URI, and
// return the updated row. The caller MUST have org-validated the audience.
export async function generateAvatar(
  orgId: string,
  audienceId: string,
  prompt: string,
  identity: Identity
): Promise<typeof audiences.$inferSelect> {
  const img = await generateImage({
    prompt,
    identity: {
      orgId: identity.orgId,
      ...(identity.userId ? { userId: identity.userId } : {}),
      ...(identity.runId ? { runId: identity.runId } : {}),
      ...(identity.workflowTracking
        ? { workflowTracking: identity.workflowTracking }
        : {}),
    },
  });
  const dataUri = `data:${img.mimeType};base64,${img.imageBase64}`;
  const [updated] = await db
    .update(audiences)
    .set({ avatarUrl: dataUri, updatedAt: new Date() })
    .where(and(eq(audiences.id, audienceId), eq(audiences.orgId, orgId)))
    .returning();
  return updated;
}

// Platform-path avatar generation for internal sweeps (the avatar backfill). Uses
// chat-service's ORG-LESS platform image endpoint — no org/user/run identity, no
// org billing (platform-run cost) — so it works for EVERY audience including the
// ones with no created_by_user_id, and bills no one. Writes the same data: URI.
export async function generateAudienceAvatarViaPlatform(
  orgId: string,
  audienceId: string,
  prompt: string
): Promise<void> {
  const img = await platformGenerateImage({ prompt });
  const dataUri = `data:${img.mimeType};base64,${img.imageBase64}`;
  await db
    .update(audiences)
    .set({ avatarUrl: dataUri, updatedAt: new Date() })
    .where(and(eq(audiences.id, audienceId), eq(audiences.orgId, orgId)));
}
