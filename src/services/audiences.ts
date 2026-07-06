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

import { and, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import {
  audienceMembers,
  audiences,
  brandSuppressions,
  people,
  type Audience,
} from "../db/schema.js";
import {
  filterSuppressed,
  normalizeEmail,
  normalizeLinkedinUrl,
  windowCutoff,
  type ServedContact,
} from "./suppression.js";
import { bufferTeasers, popTeaser } from "./teaser-buffer.js";
import {
  dryRun,
  peopleSearch,
  resolveEmail,
  toServedContact,
  type Identity,
  type Person,
  type PeopleSearchFilters,
} from "./people-providers.js";
import {
  completeJson,
  platformCompleteJson,
  generateImage,
  platformGenerateImage,
  ChatServiceError,
} from "../lib/chat-client.js";
import {
  suggestApolloAudience,
  apolloAudienceDryRun,
  type ApolloFilters,
} from "../lib/apollo-audiences.js";

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

// Re-snapshot an audience's count via the free dry-run. Fail loud on provider
// error. Returns the updated counts; persistence is the caller's job.
//
// Pointer model ("one filter vocabulary" Wave 2): an apollo audience counts by
// POINTER — apollo-service owns the faithful filters, so we ask it to re-count
// via POST /audiences/{id}/dry-run. Its apifyCount is not meaningful (the audience
// committed to apollo), so it is left as stored. A legacy/neutral audience (apify,
// or a pre-pointer apollo row) keeps the dual free dry-run on its stored NEUTRAL
// filters (apollo /search/dry-run + apify /search/count).
export async function refreshAudienceCounts(
  audience: typeof audiences.$inferSelect,
  identity: Identity
): Promise<{
  apolloCount: number | null;
  apifyCount: number | null;
  countedAt: Date;
}> {
  if (audience.apolloAudienceId) {
    const { count } = await apolloAudienceDryRun(
      audience.apolloAudienceId,
      identity
    );
    return {
      apolloCount: count,
      apifyCount: audience.apifyCount,
      countedAt: new Date(),
    };
  }
  const filters = (audience.filters ?? {}) as PeopleSearchFilters;
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

  // Membership rows for the matched people, joined to their audiences. A LEFT
  // JOIN onto the canonical audience resolves a DEPRECATED provider-variant
  // (e.g. "<base> [Apify]") to its live replacement, so a lead sourced via the
  // retired apify audience reports the clean active audience the dashboard
  // already loads (with name + avatar) instead of the deprecated "[Apify]" row.
  const canonical = alias(audiences, "canonical_audience");
  const memberships =
    matchedIds.length > 0
      ? await db
          .select({
            personId: audienceMembers.personId,
            matchedAudienceId: audiences.id,
            matchedName: audiences.name,
            matchedBrandId: audiences.brandId,
            matchedStatus: audiences.status,
            canonicalAudienceId: canonical.id,
            canonicalName: canonical.name,
            canonicalBrandId: canonical.brandId,
          })
          .from(audienceMembers)
          .innerJoin(audiences, eq(audienceMembers.audienceId, audiences.id))
          .leftJoin(
            canonical,
            eq(audiences.canonicalAudienceId, canonical.id)
          )
          .where(
            and(
              eq(audienceMembers.orgId, orgId),
              inArray(audienceMembers.personId, matchedIds)
            )
          )
      : [];

  // De-dupe per person AND per audience on the RESOLVED audience id: a person on
  // both the deprecated variant and its canonical twin must surface the canonical
  // audience exactly once (and count once in the per-audience rollup).
  const perPerson = new Map<string, Map<string, string>>(); // personId -> (audienceId -> name)
  const perAudience = new Map<
    string,
    { audienceId: string; name: string; brandId: string; members: Set<string> }
  >();
  for (const m of memberships) {
    // Resolve deprecated -> canonical when a link exists; otherwise keep the row.
    const useCanonical =
      m.matchedStatus === "deprecated" && m.canonicalAudienceId !== null;
    const audienceId = useCanonical
      ? (m.canonicalAudienceId as string)
      : m.matchedAudienceId;
    const name = useCanonical ? (m.canonicalName as string) : m.matchedName;
    const brandId = useCanonical
      ? (m.canonicalBrandId as string)
      : m.matchedBrandId;

    const personMap = perPerson.get(m.personId) ?? new Map<string, string>();
    personMap.set(audienceId, name);
    perPerson.set(m.personId, personMap);

    const agg = perAudience.get(audienceId) ?? {
      audienceId,
      name,
      brandId,
      members: new Set<string>(),
    };
    agg.members.add(m.personId);
    perAudience.set(audienceId, agg);
  }

  const matched = matchedPeople.map((p) => ({
    personId: p.id,
    emailNorm: p.emailNorm,
    fullName: p.fullName,
    audiences: [...(perPerson.get(p.id)?.entries() ?? [])].map(
      ([audienceId, name]) => ({ audienceId, name })
    ),
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
    byAudience: [...perAudience.values()].map((a) => ({
      audienceId: a.audienceId,
      name: a.name,
      brandId: a.brandId,
      matchedCount: a.members.size,
    })),
  };
}

// Contactability rollup for the audiences list (dashboard "Size" / "Remaining"
// columns). For each audience returns three ready numbers:
//
//   sizeCount               — total contactable pool = the committed provider's
//                             count snapshot (apollo -> apolloCount, apify ->
//                             apifyCount). A never-counted row (null) is 0.
//   availableToContactCount — pool members NOT suppressed within the 3-month
//                             re-contact window = sizeCount minus the audience's
//                             members currently suppressed brand-wide (across all
//                             providers). Never-served people are all available;
//                             a member last served >3 months ago is available
//                             again (re-contactable); a member served within the
//                             window is suppressed and subtracted.
//   availableToContactPct   — round(available / size * 100), integer 0..100. 0
//                             when sizeCount is 0 (the one divide-by-zero guard).
//
// Suppression truth is the SAME per-brand cross-provider silver the serve path
// enforces (`brand_suppressions` + the shared `windowCutoff`), intersected with
// each audience's provenance membership. We never enumerate the provider pool
// locally — the served subset is the only pool slice whose suppression we can
// know, and every never-served pool member is available by definition, so
// `size - servedWithinWindow` is the exact available count.
export interface AudienceContactability {
  sizeCount: number;
  availableToContactCount: number;
  availableToContactPct: number;
}

export async function computeAudienceContactability(
  rows: Audience[]
): Promise<Map<string, AudienceContactability>> {
  const result = new Map<string, AudienceContactability>();
  if (rows.length === 0) return result;

  const audienceIds = rows.map((r) => r.id);

  // One grouped query: per audience, the count of DISTINCT members whose person
  // is currently suppressed for the audience's brand within the window. Match on
  // email_norm (canonical) OR linkedin_url_norm (cross-provider pre-pay key) —
  // exactly the identities the serve path suppresses on.
  const suppressedRows = await db
    .select({
      audienceId: audienceMembers.audienceId,
      suppressed: sql<number>`count(distinct ${audienceMembers.personId})`,
    })
    .from(audienceMembers)
    .innerJoin(audiences, eq(audienceMembers.audienceId, audiences.id))
    .innerJoin(people, eq(audienceMembers.personId, people.id))
    .innerJoin(
      brandSuppressions,
      and(
        eq(brandSuppressions.orgId, audiences.orgId),
        eq(brandSuppressions.brandId, audiences.brandId),
        gt(brandSuppressions.lastServedAt, windowCutoff()),
        or(
          eq(brandSuppressions.emailNorm, people.emailNorm),
          and(
            isNotNull(people.linkedinUrlNorm),
            eq(brandSuppressions.linkedinUrlNorm, people.linkedinUrlNorm)
          )
        )
      )
    )
    .where(inArray(audienceMembers.audienceId, audienceIds))
    .groupBy(audienceMembers.audienceId);

  const suppressedByAudience = new Map<string, number>(
    suppressedRows.map((r) => [r.audienceId, Number(r.suppressed)])
  );

  for (const row of rows) {
    // Pool = the committed provider's snapshot. apollo is the default provider,
    // so a neutral (provider null) row reads apolloCount.
    const rawSize =
      row.provider === "apify" ? row.apifyCount : row.apolloCount;
    const sizeCount = rawSize ?? 0;

    const suppressed = suppressedByAudience.get(row.id) ?? 0;
    // Clamp: a stale snapshot can report fewer in the pool than we've served.
    const availableToContactCount = Math.max(0, sizeCount - suppressed);

    const availableToContactPct =
      sizeCount === 0
        ? 0
        : Math.min(
            100,
            Math.max(0, Math.round((availableToContactCount / sizeCount) * 100))
          );

    result.set(row.id, {
      sizeCount,
      availableToContactCount,
      availableToContactPct,
    });
  }

  return result;
}

// --- Internal bulk resolver: lead -> ACTIVE audience {id,name,avatarUrl} ---
//
// Server-to-server (service-auth, no browser body cap) resolution of a large
// batch of leads to their brand-correct active audience, keyed by audienceId
// AND/OR by email. Powers lead-service#346 (dashboard Leads "Audience" column),
// which fans out the whole brand's leads (thousands of emails) in ONE call —
// impossible against org+email `/orgs/audiences/stats` (100 KB gateway cap →
// 413). This resolver differs from computeStats on every axis the consumer needs:
//   - brand-scoped (AC2): only audiences of `brandId` are ever returned, so a
//     lead is NEVER attributed a foreign-brand audience (an org spans brands).
//   - active-preferred (AC1): each membership's audience is resolved through the
//     deprecated->canonical link (reusing computeStats' resolution), then the
//     best-status membership per person wins (active > paused > archived);
//     `suggested` (never-chosen) and unlinked-`deprecated` ([Provider] variants
//     with no active twin) are excluded — we surface a live card, never a retired
//     name. Tiebreak: most-recent `last_served_at`.
//   - historical (AC3): the by-email path keys on `people.email_norm`, so a lead
//     that predates audience_id tagging (lead-service never tagged it) still
//     resolves via its serve-time membership. NO backfill needed —
//     `audience_members` is already promoted from `lead_serves` at serve time
//     (prod gap = ~16/5668 rows, dedup noise); EMAIL is the historical key, not
//     new state. Leads human-service never served resolve to null (honest — we
//     cannot invent an audience we never assigned).
//   - avatar-bearing: returns `avatarUrl` so the dashboard renders the card.
//
// No cost declared here (a pure DB read). Fail loud: a DB error propagates.

export interface ResolvedAudience {
  id: string;
  name: string;
  avatarUrl: string | null;
}

// Status precedence for the by-email pick (lower = preferred). Effective statuses
// outside this map (only unlinked `deprecated` survives post-canonical) are
// excluded before ranking, so no default rank is needed.
const AUDIENCE_STATUS_RANK: Record<string, number> = {
  active: 0,
  paused: 1,
  archived: 2,
};

// One audience row joined to its optional canonical twin. Field names mirror the
// `baseAudienceCols` select below.
interface AudienceWithCanonical {
  id: string;
  name: string;
  brandId: string;
  status: string;
  avatarUrl: string | null;
  canonicalAudienceId: string | null;
  canonId: string | null;
  canonName: string | null;
  canonBrandId: string | null;
  canonStatus: string | null;
  canonAvatarUrl: string | null;
}

// Resolve a row to its EFFECTIVE audience: a deprecated provider-variant with a
// canonical link resolves to that canonical twin (the live replacement the
// dashboard loads with a clean name + avatar); otherwise the row itself. Same
// rule computeStats applies — kept identical so /stats and the resolver agree.
function effectiveAudience(m: AudienceWithCanonical): {
  id: string;
  name: string;
  brandId: string;
  status: string;
  avatarUrl: string | null;
} {
  if (m.status === "deprecated" && m.canonId !== null) {
    return {
      id: m.canonId,
      name: m.canonName as string,
      brandId: m.canonBrandId as string,
      status: m.canonStatus as string,
      avatarUrl: m.canonAvatarUrl,
    };
  }
  return {
    id: m.id,
    name: m.name,
    brandId: m.brandId,
    status: m.status,
    avatarUrl: m.avatarUrl,
  };
}

export async function resolveAudiencesForBrand(
  orgId: string,
  brandId: string,
  input: { audienceIds?: string[]; emails?: string[] }
): Promise<{
  byAudienceId: Record<string, ResolvedAudience | null>;
  byEmail: Record<string, ResolvedAudience | null>;
}> {
  const canonical = alias(audiences, "canonical_audience");
  const baseAudienceCols = {
    id: audiences.id,
    name: audiences.name,
    brandId: audiences.brandId,
    status: audiences.status,
    avatarUrl: audiences.avatarUrl,
    canonicalAudienceId: audiences.canonicalAudienceId,
    canonId: canonical.id,
    canonName: canonical.name,
    canonBrandId: canonical.brandId,
    canonStatus: canonical.status,
    canonAvatarUrl: canonical.avatarUrl,
  };

  // --- by audienceId: direct tag -> effective (canonical-resolved) audience ---
  const audienceIds = [...new Set(input.audienceIds ?? [])];
  const byAudienceId: Record<string, ResolvedAudience | null> = {};
  if (audienceIds.length > 0) {
    const rows = await db
      .select(baseAudienceCols)
      .from(audiences)
      .leftJoin(canonical, eq(audiences.canonicalAudienceId, canonical.id))
      .where(
        and(eq(audiences.orgId, orgId), inArray(audiences.id, audienceIds))
      );
    const rowById = new Map(rows.map((r) => [r.id, r]));
    for (const aid of audienceIds) {
      const row = rowById.get(aid);
      // Not found or foreign brand -> null (brand-correct, AC2).
      if (!row || row.brandId !== brandId) {
        byAudienceId[aid] = null;
        continue;
      }
      const eff = effectiveAudience(row);
      // A retired provider-variant with no live twin (unlinked deprecated) is not
      // a card we want to surface; brand mismatch on the canonical is defensive.
      byAudienceId[aid] =
        eff.status !== "deprecated" && eff.brandId === brandId
          ? { id: eff.id, name: eff.name, avatarUrl: eff.avatarUrl }
          : null;
    }
  }

  // --- by email: person(email_norm) -> membership(brand) -> best audience ---
  const rawEmails = input.emails ?? [];
  const byEmail: Record<string, ResolvedAudience | null> = {};
  const emailToNorm = new Map<string, string | null>();
  for (const e of rawEmails) {
    emailToNorm.set(e, normalizeEmail(e));
    byEmail[e] = null; // default: unmatched
  }
  const emailNorms = [
    ...new Set(
      [...emailToNorm.values()].filter((x): x is string => x !== null)
    ),
  ];
  if (emailNorms.length > 0) {
    const rows = await db
      .select({
        emailNorm: people.emailNorm,
        lastServedAt: audienceMembers.lastServedAt,
        ...baseAudienceCols,
      })
      .from(people)
      .innerJoin(audienceMembers, eq(audienceMembers.personId, people.id))
      .innerJoin(audiences, eq(audiences.id, audienceMembers.audienceId))
      .leftJoin(canonical, eq(audiences.canonicalAudienceId, canonical.id))
      .where(
        and(
          eq(people.orgId, orgId),
          inArray(people.emailNorm, emailNorms),
          eq(audiences.brandId, brandId)
        )
      );

    // Pick the best membership per email_norm (rank, then recency).
    const best = new Map<
      string,
      { audience: ResolvedAudience; rank: number; lastServedAt: Date }
    >();
    for (const r of rows) {
      const norm = r.emailNorm as string;
      const eff = effectiveAudience(r);
      // Exclude never-chosen candidates and retired unlinked variants; a
      // canonical whose brand drifted is a defensive guard.
      if (
        eff.status === "suggested" ||
        eff.status === "deprecated" ||
        eff.brandId !== brandId
      ) {
        continue;
      }
      const rank = AUDIENCE_STATUS_RANK[eff.status] ?? 3;
      const cur = best.get(norm);
      if (
        !cur ||
        rank < cur.rank ||
        (rank === cur.rank && r.lastServedAt > cur.lastServedAt)
      ) {
        best.set(norm, {
          audience: { id: eff.id, name: eff.name, avatarUrl: eff.avatarUrl },
          rank,
          lastServedAt: r.lastServedAt,
        });
      }
    }

    for (const [raw, norm] of emailToNorm) {
      if (norm !== null) {
        const hit = best.get(norm);
        if (hit) byEmail[raw] = hit.audience;
      }
    }
  }

  return { byAudienceId, byEmail };
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

const SUGGEST_STATUS = "suggested"; // inactive default for suggest-created rows

// LLM provider/model for LAYER 1 (segment decompose) + the description backfill —
// the ONLY LLM work human-service still does for audiences. Gemini in JSON mode
// with a responseSchema (the provider ENFORCES the shape server-side, so the
// response always parses — no schemaless "non-parsable → 502" flake). Layer 2
// (NL → faithful-Apollo-filters) NO LONGER runs here: apollo-service owns that
// agentic refine loop; human-service only calls POST /audiences/suggest-from-
// segment and caches the opaque result.
const SUGGEST_LLM_PROVIDER = "google" as const;
const SUGGEST_LLM_MODEL = "flash";
// Layer 1 + description generation are narrow structured JSON tasks → thinking off.
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

const DESCRIPTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { description: { type: "string" } },
  required: ["description"],
};

export interface AudienceCandidate {
  audienceId: string;
  name: string;
  rationale: string;
  // Pointer model: a suggested candidate always commits to apollo (apollo-service
  // owns the faithful filters). `apolloAudienceId` is the apollo-service pointer.
  provider: "apollo";
  apolloAudienceId: string;
  // The faithful Apollo filter object (opaque — apollo-service owns its shape),
  // cached on the persisted row + echoed back here.
  filters: ApolloFilters;
  count: number;
  status: string;
  // Retained for response-shape stability. apollo-service confirms a real audience
  // (or fails loud), so a returned candidate never carries a validation error and
  // is never truncated — always null / false.
  validationError: string | null;
  truncated: boolean;
}

// --- Layer 1: decompose NL into named audiences ---

interface Segment {
  name: string;
  description: string;
}

function buildLayer1SystemPrompt(): string {
  return [
    "You decompose a natural-language audience request into a SET of distinct,",
    "named target audiences. PROACTIVELY split a heterogeneous request into one",
    "audience per clearly-distinct facet -- you do NOT need the caller to write",
    '"separately" or "split by". A facet is distinct when the request spans more',
    "than one value on any ICP axis below: different PERSONAS (e.g. founders AND",
    "heads of growth AND solo marketers), different GEOGRAPHIES (e.g. US AND",
    "France AND Germany), different INDUSTRIES (e.g. SaaS AND e-commerce), or",
    "different COMPANY TYPES (e.g. B2B SaaS AND digital product companies).",
    "When multiple independent axes are explicitly present, output the concrete",
    "COMBINATIONS of those axes, not a broad merged bucket. Example: 3 personas",
    "x 2 company types = 6 audiences. Each combination gets its OWN audience",
    "because each maps to a different people-search filter set. If the caller is",
    "explicit about grouping (\"US and Europe separately\", \"one broad list\"),",
    "honor that intent exactly.",
    "",
    "BUT do NOT over-split a genuinely COHESIVE request. A single persona in a",
    "single geography/industry (e.g. \"founders of B2B SaaS startups in the US\")",
    "is ONE audience -- splitting it into noise (e.g. by arbitrary sub-titles or",
    "company sizes the caller never mentioned) is wrong. Split only on axes the",
    "caller actually spans; never invent a grouping dimension. Do not merge two",
    "different personas merely because they share the same company constraints,",
    "and do not merge two different company types merely because they share the",
    "same persona constraints.",
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
    "  from without re-reading the original request. The next Apollo/APIFY expert",
    "  receives ONLY this description, not the original user prompt, so carry over",
    "  EVERY shared and segment-specific constraint the caller stated. Never drop",
    "  or invent one.",
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
): Promise<Segment[]> {
  return parseSegments(
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
  apolloAudienceId: string;
  filters: ApolloFilters;
  count: number;
}): Promise<string> {
  const orgId = args.identity.orgId;
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
            provider: "apollo",
            apolloAudienceId: args.apolloAudienceId,
            filters: args.filters as Record<string, unknown>,
            apolloCount: args.count,
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
        provider: "apollo",
        apolloAudienceId: args.apolloAudienceId,
        status: SUGGEST_STATUS,
        filters: args.filters as Record<string, unknown>,
        apolloCount: args.count,
        countedAt: new Date(),
        createdByUserId: args.identity.userId ?? null,
      })
      .returning({ id: audiences.id });
    return row.id;
  });
}

// Turn a natural-language prompt into a set of PERSISTED candidate audiences.
// Layer 1 (human-service) decomposes the NL into named segments; per segment we
// ask apollo-service to BUILD + COUNT a faithful Apollo audience (it owns the
// NL→faithful-Apollo-filters agentic refine loop now). human-service stores only
// the POINTER (apollo_audience_id) + a cache of the opaque filters + the count,
// at status "suggested" (inactive). Best-provider collapse degenerates to apollo
// (apify is inert). Fault-tolerant: one segment's apollo-service failure doesn't
// nuke the batch (allSettled); FAIL LOUD only when EVERY segment failed (502).
// The caller activates chosen ids via PATCH /orgs/audiences/{id}/status.
export async function suggestAudiences(
  nlPrompt: string,
  brandId: string,
  identity: Identity
): Promise<AudienceCandidate[]> {
  const segments = await decomposeSegments(nlPrompt, identity);

  // One apollo-service call per segment, concurrent + fault-tolerant.
  const settled = await Promise.allSettled(
    segments.map(async (segment) => {
      const apollo = await suggestApolloAudience({
        name: segment.name,
        description: segment.description,
        brandId,
        identity,
      });
      return { segment, apollo };
    })
  );

  const ok = settled
    .filter(
      (
        r
      ): r is PromiseFulfilledResult<{
        segment: Segment;
        apollo: Awaited<ReturnType<typeof suggestApolloAudience>>;
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
  if (ok.length === 0 && segments.length > 0) {
    throw failures[0]?.reason ?? new ChatServiceError(502, "all segments failed");
  }

  // Persist sequentially (one row per segment; names are distinct, so no
  // intra-request collision; the unique index guards cross-request races).
  const out: AudienceCandidate[] = [];
  for (const { segment, apollo } of ok) {
    const audienceId = await persistSuggestedAudience({
      identity,
      brandId,
      nlPrompt,
      segment,
      apolloAudienceId: apollo.apolloAudienceId,
      filters: apollo.filters,
      count: apollo.count,
    });
    out.push({
      audienceId,
      name: segment.name,
      rationale: segment.description,
      provider: "apollo",
      apolloAudienceId: apollo.apolloAudienceId,
      filters: apollo.filters,
      count: apollo.count,
      status: SUGGEST_STATUS,
      validationError: null,
      truncated: false,
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

// Build an equivalent APOLLO audience for one apify audience and retire the apify
// one. The apify filters are NOT copied — apollo-service builds the faithful
// Apollo audience from the row's name + description via its own NL→faithful-
// filters refine loop (POST /audiences/suggest-from-segment) and returns the
// pointer + opaque filters + count. Then, atomically: deprecate + rename the apify
// row (freeing the unique name) and insert a new apollo audience storing that
// POINTER + cached filters + count, MIRRORING the source status (an active apify
// audience becomes an active apollo one; a suggested one stays suggested). Returns
// null when apollo-service yields no usable filter set — the caller logs + skips,
// leaving the apify row untouched (retried on re-run).
//
// NOTE: apollo-service's suggest endpoint is org-scoped (the LLM cost it incurs
// is owned + metered by apollo-service/chat-service against this row's org). The
// prior platform-LLM path is gone with the in-human-service Layer-2 loop; this
// is a one-time admin sweep over a small set of rows.
export async function migrateApifyAudienceToApollo(
  row: typeof audiences.$inferSelect
): Promise<ApifyToApolloMigrationResult | null> {
  const identity: Identity = {
    orgId: row.orgId,
    userId: row.createdByUserId ?? undefined,
  };
  const built = await suggestApolloAudience({
    name: row.name,
    description: row.description ?? row.name,
    brandId: row.brandId,
    identity,
  });
  if (!built.filters || Object.keys(built.filters).length === 0) {
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
        apolloAudienceId: built.apolloAudienceId,
        status: row.status,
        source: MIGRATED_FROM_APIFY_SOURCE,
        filters: built.filters as Record<string, unknown>,
        apolloCount: built.count,
        countedAt: new Date(),
        createdByUserId: row.createdByUserId,
      })
      .returning({ id: audiences.id });

    // Durable canonical link: the deprecated apify row points at its live apollo
    // replacement so membership / stats reads resolve to the clean active twin.
    await tx
      .update(audiences)
      .set({ canonicalAudienceId: apollo.id })
      .where(eq(audiences.id, row.id));

    return {
      apifyAudienceId: row.id,
      apolloAudienceId: apollo.id,
      name: row.name,
      status: row.status,
      apolloCount: built.count,
    };
  });
}

// --- Apollo-audience-pointer backfill (one-time) ---
//
// Pre-Wave-2 apollo audiences (native apollo rows + the apify->apollo migrated
// ones) hold a human-built / lossy neutral filter blob and NO apollo_audience_id.
// This backfill gives each such row a faithful Apollo audience: it asks apollo-
// service to BUILD one from the row's own name + description (apollo-service owns
// the NL->faithful-filters loop), then stores the POINTER + the faithful filters
// (cached, replacing the old neutral blob — that blob was exactly the lossy
// vocabulary this wave removes) + the count snapshot. Returns null when apollo-
// service yields no usable filter set (caller logs + skips, retried on re-run).

export interface ApolloPointerBackfillResult {
  id: string;
  name: string;
  apolloAudienceId: string;
  count: number;
}

export async function backfillApolloAudiencePointer(
  row: typeof audiences.$inferSelect
): Promise<ApolloPointerBackfillResult | null> {
  const identity: Identity = {
    orgId: row.orgId,
    userId: row.createdByUserId ?? undefined,
  };
  const built = await suggestApolloAudience({
    name: row.name,
    description: row.description ?? row.name,
    brandId: row.brandId,
    identity,
  });
  if (!built.filters || Object.keys(built.filters).length === 0) {
    return null;
  }
  await db
    .update(audiences)
    .set({
      apolloAudienceId: built.apolloAudienceId,
      filters: built.filters as Record<string, unknown>,
      apolloCount: built.count,
      countedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(audiences.id, row.id));
  return {
    id: row.id,
    name: row.name,
    apolloAudienceId: built.apolloAudienceId,
    count: built.count,
  };
}

// --- Canonical-link backfill (deprecated provider-variant -> active replacement) ---
//
// The apify->apollo migration deprecated + renamed each apify audience
// "<base> [Apify]" and created an active apollo twin named "<base>", but stored
// NO link between them. This backfill sets `canonical_audience_id` on each
// deprecated provider-variant row, pointing at its live same-(org,brand)-base-name
// sibling, so membership / stats reads resolve to the clean active audience.

// Strip a trailing " [Provider]" variant suffix from a deprecated audience name.
// Returns the base name, or null if the name has no variant suffix (so it is not
// a migration-retired provider-variant and must be skipped — never guessed).
export function parseVariantBaseName(name: string): string | null {
  const m = /^(.*\S) \[[^\]]+\]$/.exec(name);
  return m ? m[1] : null;
}

export type CanonicalLinkOutcome =
  | { id: string; name: string; status: "linked"; canonicalAudienceId: string }
  | { id: string; name: string; status: "skipped"; reason: string };

// Resolve + (optionally) set the canonical link for ONE deprecated row. Matching
// is scoped to (org_id, brand_id, lower(base_name)) and EXCLUDES deprecated rows;
// the unique index idx_audiences_org_brand_lower_name guarantees at most one such
// sibling per (org, brand). 0 siblings OR a name with no variant suffix -> skip +
// log (never guess). When dryRun, computes the outcome WITHOUT writing.
export async function linkCanonicalForDeprecated(
  row: Pick<
    typeof audiences.$inferSelect,
    "id" | "orgId" | "brandId" | "name"
  >,
  opts: { dryRun: boolean }
): Promise<CanonicalLinkOutcome> {
  const base = parseVariantBaseName(row.name);
  if (base === null) {
    return {
      id: row.id,
      name: row.name,
      status: "skipped",
      reason: "no provider-variant suffix",
    };
  }

  const siblings = await db
    .select({ id: audiences.id })
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, row.orgId),
        eq(audiences.brandId, row.brandId),
        sql`lower(${audiences.name}) = ${base.toLowerCase()}`,
        sql`${audiences.status} <> 'deprecated'`
      )
    );

  if (siblings.length === 0) {
    return {
      id: row.id,
      name: row.name,
      status: "skipped",
      reason: "no active sibling",
    };
  }
  if (siblings.length > 1) {
    // Structurally prevented by the unique index, but fail loud (skip) defensively
    // rather than picking an arbitrary canonical.
    return {
      id: row.id,
      name: row.name,
      status: "skipped",
      reason: `ambiguous: ${siblings.length} active siblings`,
    };
  }

  const canonicalAudienceId = siblings[0].id;
  if (!opts.dryRun) {
    await db
      .update(audiences)
      .set({ canonicalAudienceId })
      .where(eq(audiences.id, row.id));
  }
  return { id: row.id, name: row.name, status: "linked", canonicalAudienceId };
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

// serve-next's LOCKED consumer contract (lead-service): status="served" MUST mean
// a contactable person WITH a usable email. A provider can hand back a person
// record that has NO email — apollo /enrich returns a person whose `email` is null
// when the email is locked / not-found / unverifiable, and (defensively) an apify
// hit could carry an empty string. Such a person is NOT servable: committing it as
// "served" pushes an uncontactable lead into the cold-email funnel, which the
// consumer correctly rejects (fail-loud) and crash-loops the campaign. This guard
// is the single truth for "does this person satisfy the served contract".
function hasUsableEmail(p: Person): boolean {
  return typeof p.email === "string" && p.email.trim().length > 0;
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
  // Stored filters are OPAQUE here: apollo rows hold the faithful Apollo filter
  // object (apollo-service's shape); apify rows hold the neutral PeopleSearchFilters.
  const storedFilters = (audience.filters ?? null) as Record<string, unknown> | null;
  if (!storedFilters || Object.keys(storedFilters).length === 0) {
    throw new AudienceNotServableError(
      "Audience has no stored filters — cannot serve people."
    );
  }

  if (provider === "apify") {
    // apify BILLS per returned lead and pushes the brand exclude-set down, so a
    // single hit is already an unserved, suppression-recorded serve. limit 1. apify
    // audiences keep the NEUTRAL filter shape (mapped to apify in the gateway).
    const result = await peopleSearch({
      provider: "apify",
      filters: storedFilters as PeopleSearchFilters,
      limit: 1,
      audienceId: audience.id,
      identity,
    });
    const person = result.people[0] ?? null;
    // A no-email hit violates the served contract (apify is supposed to return a
    // verified email per hit; a blank one is junk). It was already billed +
    // suppression-recorded by the gateway, so surface exhausted rather than
    // committing an uncontactable person as served.
    if (!person || !hasUsableEmail(person)) {
      return { status: "exhausted", person: null };
    }
    await tagAudienceServe(identity.orgId, audience.id, [
      toServedContact(person),
    ]);
    return { status: "served", person };
  }

  // apollo: search is a FREE teaser list. Apollo's /search/next hands back up to
  // 100 teasers per page AND advances its forward-only cursor a whole page, while
  // serve-next reveals ONE lead per call — so we BUFFER each fetched page and
  // DRAIN it one teaser per call, only re-advancing apollo's cursor when the
  // buffer is empty. Without this the other ~99 teasers per page were discarded
  // and the cursor moved on for good, capping the audience at ~1% of its pool.
  //
  // Pointer rows (apollo_audience_id set) store Apollo's FAITHFUL filter shape →
  // forward it VERBATIM as the apollo search params (no neutral→apollo remap). A
  // LEGACY pre-Wave-2 apollo row (no pointer) still holds the old NEUTRAL blob →
  // let toApolloSearchParams remap it, so it keeps serving until the backfill
  // gives it a pointer. Mirrors the same guard in refreshAudienceCounts.
  const apolloSearchParams = audience.apolloAudienceId ? storedFilters : undefined;
  const apolloFilters = audience.apolloAudienceId
    ? {}
    : (storedFilters as PeopleSearchFilters);

  // Drain loop: pop one buffered teaser per iteration; refill (advancing apollo's
  // cursor) only when the buffer is dry. Enrich ONE non-suppressed teaser at a
  // time (the billed reveal records the serve in finalizeResolved) and return on
  // the first reveal. Exhausted ONLY when the buffer is empty AND apollo returns
  // no more fresh teasers — never a fabricated cap (apollo's `done` at totalPages
  // guarantees termination, so the walk is bounded by the real pool).
  for (;;) {
    const teaser = await popTeaser(identity.orgId, audience.id);
    if (!teaser) {
      // Buffer dry → advance apollo's free cursor one fruitful chunk. peopleSearch
      // already drops brand-suppressed teasers before returning, and returns the
      // page's fresh teasers (or [] at true apollo pool exhaustion).
      const search = await peopleSearch({
        provider: "apollo",
        filters: apolloFilters,
        apolloSearchParams,
        audienceId: audience.id,
        identity,
      });
      if (search.people.length === 0) {
        return { status: "exhausted", person: null };
      }
      await bufferTeasers(identity.orgId, audience.id, search.people);
      continue;
    }

    // Re-check suppression pre-pay: a teaser fresh at buffer time may have been
    // served under ANOTHER audience for this brand since (cross-audience, within
    // the window) — drop it before paying to enrich.
    const [fresh] = await filterSuppressed(
      identity.orgId,
      [audience.brandId],
      [{ linkedinUrl: teaser.linkedinUrl, providerPersonId: teaser.providerPersonId }]
    );
    if (!fresh) continue;

    const revealed = await resolveEmail({
      provider: "apollo",
      providerPersonId: teaser.providerPersonId,
      audienceId: audience.id,
      identity,
    });
    // Only commit as served when the reveal produced a person WITH a usable email
    // — apollo /enrich can return a person record whose `email` is null (locked /
    // not-found), and serving that violates the consumer contract. The credit is
    // already spent + the serve suppression-recorded in finalizeResolved, so a
    // no-email reveal is simply dropped and we pop the next teaser (never wasting
    // it on a re-enrich).
    if (revealed.person && hasUsableEmail(revealed.person)) {
      await tagAudienceServe(identity.orgId, audience.id, [
        toServedContact(revealed.person),
      ]);
      return { status: "served", person: revealed.person };
    }
    // Reveal yielded no usable email, or was post-pay suppressed → drop, pop the
    // next buffered teaser.
  }
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
// (which owns the image-gen cost), store the hosted URL, and return the updated
// row.
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
  const [updated] = await db
    .update(audiences)
    .set({ avatarUrl: img.url, updatedAt: new Date() })
    .where(and(eq(audiences.id, audienceId), eq(audiences.orgId, orgId)))
    .returning();
  if (!updated) {
    throw new Error(`Audience not found: ${audienceId}`);
  }
  return updated;
}

// Platform-path avatar generation for internal sweeps (the avatar backfill). Uses
// chat-service's ORG-LESS platform image endpoint — no org/user/run identity, no
// org billing (platform-run cost) — so it works for EVERY audience including the
// ones with no created_by_user_id, and bills no one. Stores hosted URLs.
export async function generateAudienceAvatarViaPlatform(
  orgId: string,
  audienceId: string,
  prompt: string
): Promise<void> {
  const img = await platformGenerateImage({ prompt });
  await db
    .update(audiences)
    .set({ avatarUrl: img.url, updatedAt: new Date() })
    .where(and(eq(audiences.id, audienceId), eq(audiences.orgId, orgId)));
}
