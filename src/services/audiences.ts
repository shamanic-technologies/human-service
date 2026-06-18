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
  type Identity,
  type PeopleSearchFilters,
} from "./people-providers.js";

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
