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
  dryRun,
  filtersPrompt,
  ProviderError,
  type Identity,
  type PeopleSearchFilters,
  type Provider,
} from "./people-providers.js";
import { completeJson, ChatServiceError } from "../lib/chat-client.js";

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

// --- Audience suggestion (onboarding NL -> candidate audiences) ---
//
// The user types a natural-language audience description. For each provider we
// hand the NL + that provider's filter rulebook (its /search/filters-prompt) to
// the LLM (via chat-service /complete, which OWNS the LLM cost), and the LLM
// reads the user's own granularity intent ("split by country", "founders in FR
// and DE separately", "one broad list") to emit a SET of candidate audiences.
// Each candidate is counted via the free dry-run; a candidate that returns zero
// or invalid filters is fed back to the LLM to revise (bounded). The user then
// picks any number and persists them via POST /orgs/audiences.
//
// Membership/dedup stays untouched; this is purely the discovery step. No cost
// declared here — chat-service meters the LLM spend against the org.

const SUGGEST_PROVIDERS: Provider[] = ["apollo", "apify"];
const SUGGEST_MAX_CANDIDATES_PER_PROVIDER = 6; // safety backstop (not a knob)
const SUGGEST_MAX_REVISE_ROUNDS = 3;

// LLM provider/model for the suggest flow. We use Gemini in SCHEMALESS JSON mode
// (responseMimeType: application/json, no responseSchema) rather than Anthropic:
// chat-service rejects anthropic JSON mode without a responseSchema, and
// Anthropic's strict schema requires `additionalProperties:false` + an explicit
// `properties` map on EVERY object — which cannot express our open `filters`
// blob (~16 optional neutral fields) without enumerating + over-constraining it.
// Gemini's native JSON mode needs no schema, so the shape stays prompt-described
// + caller-validated (`parseCandidates` + the per-filter dry-run). flash is also
// ~10-20x cheaper than sonnet, cutting the per-suggest cost.
const SUGGEST_LLM_PROVIDER = "google" as const;
const SUGGEST_LLM_MODEL = "flash";

export interface AudienceCandidate {
  provider: Provider;
  label: string;
  rationale: string;
  filters: PeopleSearchFilters;
  count: number;
  validationError: string | null;
  truncated: boolean;
}

interface RawCandidate {
  label: string;
  rationale: string;
  filters: PeopleSearchFilters;
}

function parseCandidates(obj: Record<string, unknown>): RawCandidate[] {
  const arr = obj.candidates;
  if (!Array.isArray(arr)) {
    throw new ChatServiceError(502, "LLM response missing `candidates` array");
  }
  return arr.map((c, i) => {
    if (!c || typeof c !== "object") {
      throw new ChatServiceError(502, `LLM candidate ${i} is not an object`);
    }
    const o = c as Record<string, unknown>;
    if (typeof o.label !== "string" || o.label.length === 0) {
      throw new ChatServiceError(502, `LLM candidate ${i} missing label`);
    }
    if (!o.filters || typeof o.filters !== "object") {
      throw new ChatServiceError(502, `LLM candidate ${i} missing filters`);
    }
    return {
      label: o.label,
      rationale: typeof o.rationale === "string" ? o.rationale : "",
      filters: o.filters as PeopleSearchFilters,
    };
  });
}

function buildSuggestSystemPrompt(provider: Provider, rules: string): string {
  return [
    `You are an expert at building ${provider} people-search audiences.`,
    "",
    "PROVIDER FILTER RULES (authoritative — only these values are valid):",
    rules,
    "",
    "The caller sends a natural-language description of who they want to reach.",
    "READ the caller's text for any GRANULARITY / SEGMENTATION intent (e.g.",
    '"split by country", "founders in France and Germany separately", "by',
    'seniority"). Produce ONE candidate audience per segment they imply. If they',
    "imply no split, produce a single broad candidate. The number and the",
    "grouping dimension come from the CALLER's words, never invented. Never",
    `produce more than ${SUGGEST_MAX_CANDIDATES_PER_PROVIDER} candidates — if the`,
    "text implies more, group coarser and say so in the rationale.",
    "",
    'Each candidate\'s "filters" MUST use ONLY these neutral fields (omit any you',
    "don't use): titles[], seniorities[] (one of: entry, senior, manager,",
    "director, vp, c_suite, owner, founder, partner), functions[],",
    "locationCountries[], locationStates[], locationCities[], companyNames[],",
    "companyDomains[], industries[], keywords[], employeeMin (int), employeeMax",
    `(int), companySizes[], revenueRanges[], fundingStages[], technologies[].`,
    "Populate the fields THIS provider honors best per the rules above.",
    "",
    "Respond with ONLY valid JSON of this EXACT shape (no prose, no markdown):",
    '{"candidates":[{"label":"<short human label>","rationale":"<one sentence',
    'why these filters match>","filters":{ ... }}]}',
  ].join("\n");
}

function buildRevisePrompt(nlPrompt: string, failing: AudienceCandidate[]): string {
  const lines = failing.map(
    (f) =>
      `- label "${f.label}": ${
        f.validationError
          ? "INVALID filters (" + f.validationError + ")"
          : "ZERO matches"
      } — filters were ${JSON.stringify(f.filters)}`
  );
  return [
    `Original request: ${nlPrompt}`,
    "",
    "These candidates returned ZERO matches or INVALID filters. Revise each to",
    "be broader and valid while staying true to the original request. Keep the",
    "SAME label for each so it can be matched back:",
    ...lines,
    "",
    'Respond with the same JSON shape {"candidates":[...]} containing ONLY the',
    "revised versions of these labels.",
  ].join("\n");
}

// Count a candidate's filters via the free dry-run. A provider 4xx means the
// filters are invalid (LLM's fault → feed back to revise); a 5xx / network /
// config error is a real outage → rethrow (fail loud). NOT a swallow: the 4xx
// IS the validation signal the loop exists to consume.
async function dryRunSafe(
  provider: Provider,
  filters: PeopleSearchFilters,
  identity: Identity
): Promise<{ count: number; validationError: string | null }> {
  try {
    const { totalEntries } = await dryRun({ provider, filters, identity });
    return { count: totalEntries, validationError: null };
  } catch (err) {
    if (err instanceof ProviderError && err.status >= 400 && err.status < 500) {
      return { count: 0, validationError: err.message };
    }
    throw err;
  }
}

async function suggestForProvider(
  provider: Provider,
  nlPrompt: string,
  identity: Identity
): Promise<AudienceCandidate[]> {
  const rules = (await filtersPrompt({ provider, identity })).prompt;
  const systemPrompt = buildSuggestSystemPrompt(provider, rules);

  const initial = parseCandidates(
    await completeJson({
      message: nlPrompt,
      systemPrompt,
      identity,
      provider: SUGGEST_LLM_PROVIDER,
      model: SUGGEST_LLM_MODEL,
    })
  );
  const truncated = initial.length > SUGGEST_MAX_CANDIDATES_PER_PROVIDER;

  const working: AudienceCandidate[] = initial
    .slice(0, SUGGEST_MAX_CANDIDATES_PER_PROVIDER)
    .map((c) => ({
      provider,
      label: c.label,
      rationale: c.rationale,
      filters: c.filters,
      count: -1,
      validationError: null,
      truncated,
    }));

  for (let round = 0; round <= SUGGEST_MAX_REVISE_ROUNDS; round++) {
    await Promise.all(
      working.map(async (w) => {
        if (w.count > 0 && !w.validationError) return; // already good
        const r = await dryRunSafe(provider, w.filters, identity);
        w.count = r.count;
        w.validationError = r.validationError;
      })
    );
    const failing = working.filter(
      (w) => w.count === 0 || w.validationError !== null
    );
    if (failing.length === 0 || round === SUGGEST_MAX_REVISE_ROUNDS) break;

    const revised = parseCandidates(
      await completeJson({
        message: buildRevisePrompt(nlPrompt, failing),
        systemPrompt,
        identity,
        provider: SUGGEST_LLM_PROVIDER,
        model: SUGGEST_LLM_MODEL,
      })
    );
    for (const w of failing) {
      const match = revised.find((r) => r.label === w.label);
      if (match) {
        w.filters = match.filters;
        w.rationale = match.rationale;
        w.count = -1;
        w.validationError = null;
      }
    }
  }

  return working.map((w) => ({
    ...w,
    count: w.count < 0 ? 0 : w.count,
  }));
}

// Turn a natural-language prompt into a set of candidate audiences across both
// providers (apollo + apify), each with its filters + live count. Fail loud: a
// provider/chat outage propagates (502). The caller picks candidates and
// persists them via POST /orgs/audiences.
export async function suggestAudiences(
  nlPrompt: string,
  identity: Identity
): Promise<AudienceCandidate[]> {
  const perProvider = await Promise.all(
    SUGGEST_PROVIDERS.map((p) => suggestForProvider(p, nlPrompt, identity))
  );
  return perProvider.flat();
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
