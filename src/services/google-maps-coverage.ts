// GMAPS-COVERAGE-1126: a Google Maps list says "exhausted" only once its target region is really covered.
//
// A list is drafted once with a few dozen searches (kinds of business x the biggest towns). Living Vital
// (2026-11-24): 40 searches over 10 cities of German-speaking Switzerland all ran, the walk answered exhausted,
// while the canton of St. Gallen alone held 51 drugstores the list never searched, and "Drogerie in Zürich" /
// "Drogerie in Basel" stopped at the provider's 100-result ceiling. So when every search of a list ran, the walk
// asks for the next searches (one model call, src/lib/google-maps-coverage-draft.ts) seeing every search with its
// yield and whether it hit the ceiling, and the towns found so far: finer areas for a search at the ceiling, the
// towns of the region not searched yet. Same rule for every brand and country: no town list in code.
//
// A list is covered (exhausted) when: the model says the region is covered (reason stored), OR it writes nothing
// new, OR a whole round of its searches found no new place (measured, never a promise), OR the list reached
// GOOGLE_MAPS_MAX_TOTAL_QUERIES (logged loud). One round at a time per list: the round row is the claim.

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { googleMapsCoverageRounds, googleMapsPlaces, googleMapsQueries, audiences } from "../db/schema.js";
import { draftCoverageSearches, type CoverageSearchFact } from "../lib/google-maps-coverage-draft.js";
import type { Identity } from "./people-providers.js";
import { cityOfAddress, countryName, GoogleMapsSourceError, readPlace, type GoogleMapsFilters } from "./google-maps-source.js";

/** A list never holds more searches than this (each costs a fraction of a cent; a runaway stops here, loud). */
export const GOOGLE_MAPS_MAX_TOTAL_QUERIES = 1_500;
/** A round claimed and never decided (a dead serve) is retaken after this. */
const DRAFTING_LEASE_MS = 5 * 60 * 1000;
/** At most this many towns are shown to the model (most places first). */
const MAX_TOWNS_SHOWN = 200;

export type CoverageOutcome = "extended" | "covered" | "pending";

type AudienceRow = typeof audiences.$inferSelect;

/**
 * The most places a provider ever answered for one search, per provider (fleet-wide, measured): a search that
 * returned that many hit the ceiling. A provider seen once only has a ceiling as high as its one answer.
 */
async function providerCeilings(): Promise<Map<string, number>> {
  const rows = await db.execute<{ served_by: string; ceiling: number }>(sql`
    select served_by, max(places_count)::int as ceiling from google_maps_queries
    where served_by is not null and places_count is not null group by served_by`);
  return new Map((rows as unknown as Array<{ served_by: string; ceiling: number }>).map((r) => [r.served_by, r.ceiling]));
}

/** Every search of the list that ran, in order, with its yield and whether it hit its provider's ceiling. */
export async function coverageSearchFacts(audienceId: string): Promise<Array<CoverageSearchFact & { round: number }>> {
  const [ceilings, rows] = await Promise.all([
    providerCeilings(),
    db
      .select({
        query: googleMapsQueries.query,
        places: googleMapsQueries.placesCount,
        newPlaces: googleMapsQueries.newPlacesCount,
        servedBy: googleMapsQueries.servedBy,
        round: googleMapsQueries.coverageRound,
        ranAt: googleMapsQueries.ranAt,
      })
      .from(googleMapsQueries)
      .where(eq(googleMapsQueries.audienceId, audienceId))
      .orderBy(googleMapsQueries.coverageRound, googleMapsQueries.position),
  ]);
  return rows
    .filter((r) => r.ranAt !== null)
    .map((r) => {
      const places = r.places ?? 0;
      const ceiling = r.servedBy ? ceilings.get(r.servedBy) ?? null : null;
      return { query: r.query, places, newPlaces: r.newPlaces ?? 0, atCeiling: ceiling !== null && ceiling > 0 && places >= ceiling, round: r.round };
    });
}

async function townsFound(audienceId: string, country: string): Promise<Array<{ town: string; places: number }>> {
  const rows = await db.select({ place: googleMapsPlaces.place }).from(googleMapsPlaces).where(eq(googleMapsPlaces.audienceId, audienceId));
  const name = countryName(country);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const p = readPlace(r.place);
    const town = p.city ?? cityOfAddress(p.address, name);
    if (town) counts.set(town, (counts.get(town) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TOWNS_SHOWN)
    .map(([town, places]) => ({ town, places }));
}

async function recordCovered(audienceId: string, round: number, reason: string, regionText: string | null): Promise<void> {
  await db
    .insert(googleMapsCoverageRounds)
    .values({ audienceId, round, status: "covered", reason, regionText, decidedAt: new Date() })
    .onConflictDoNothing();
}

/**
 * Every search of the list ran: write its next searches, or say its region is covered. `regionText` = the text
 * naming who and where (the list's own, else the walking offer audience's).
 */
export async function extendGoogleMapsCoverage(
  list: AudienceRow,
  filters: GoogleMapsFilters,
  regionText: string | null,
  identity: Identity
): Promise<CoverageOutcome> {
  const [latest] = await db
    .select()
    .from(googleMapsCoverageRounds)
    .where(eq(googleMapsCoverageRounds.audienceId, list.id))
    .orderBy(desc(googleMapsCoverageRounds.round))
    .limit(1);
  if (latest?.status === "covered") return "covered";
  if (latest?.status === "drafting") {
    if (Date.now() - latest.createdAt.getTime() < DRAFTING_LEASE_MS) return "pending";
    await db.delete(googleMapsCoverageRounds).where(and(eq(googleMapsCoverageRounds.id, latest.id), eq(googleMapsCoverageRounds.status, "drafting")));
    return extendGoogleMapsCoverage(list, filters, regionText, identity);
  }
  const round = (latest?.round ?? 0) + 1;
  const facts = await coverageSearchFacts(list.id);

  // Measured end: the last round's searches all ran and found nothing new.
  if (latest?.status === "extended") {
    const last = facts.filter((f) => f.round === latest.round);
    if (last.length > 0 && last.every((f) => f.newPlaces === 0)) {
      await recordCovered(list.id, round, `round ${latest.round} (${last.length} searches) found no new place`, regionText);
      console.log(`[human-service] google_maps.coverage_covered audience=${list.id} round=${round} reason=last_round_found_nothing`);
      return "covered";
    }
  }
  const [{ n }] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from google_maps_queries where audience_id = ${list.id}`)) as unknown as Array<{ n: number }>;
  if (n >= GOOGLE_MAPS_MAX_TOTAL_QUERIES) {
    await recordCovered(list.id, round, `search cap ${GOOGLE_MAPS_MAX_TOTAL_QUERIES} reached`, regionText);
    console.error(`[human-service] google_maps.coverage_search_cap audience=${list.id} searches=${n}`);
    return "covered";
  }

  // The claim: one round at a time per list.
  const [claim] = await db
    .insert(googleMapsCoverageRounds)
    .values({ audienceId: list.id, round, status: "drafting", regionText, runId: identity.runId ?? null })
    .onConflictDoNothing()
    .returning({ id: googleMapsCoverageRounds.id });
  if (!claim) return "pending";

  try {
    const draft = await draftCoverageSearches(
      {
        regionText: regionText ?? filters.queries.join("\n"),
        country: filters.country,
        language: filters.language,
        searches: facts.map(({ query, places, newPlaces, atCeiling }) => ({ query, places, newPlaces, atCeiling })),
        towns: await townsFound(list.id, filters.country),
      },
      identity
    ).catch((err: unknown) => {
      throw new GoogleMapsSourceError(`coverage draft for list ${list.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    const known = new Set(
      (await db.select({ query: googleMapsQueries.query }).from(googleMapsQueries).where(eq(googleMapsQueries.audienceId, list.id))).map((r) => r.query.toLowerCase())
    );
    const fresh: string[] = [];
    for (const q of draft.queries) {
      if (known.has(q.toLowerCase())) continue;
      known.add(q.toLowerCase());
      fresh.push(q);
    }
    const room = GOOGLE_MAPS_MAX_TOTAL_QUERIES - n;
    const added = fresh.slice(0, Math.max(0, room));
    if (added.length === 0) {
      const reason = draft.covered ? draft.reason || "the model says the region is covered" : "the model wrote no search not already run";
      await db.update(googleMapsCoverageRounds).set({ status: "covered", reason, queries: draft.queries, decidedAt: new Date() }).where(eq(googleMapsCoverageRounds.id, claim.id));
      console.log(`[human-service] google_maps.coverage_covered audience=${list.id} round=${round} reason=${JSON.stringify(reason)}`);
      return "covered";
    }
    const [{ maxPos }] = (await db.execute<{ maxPos: number }>(
      sql`select coalesce(max(position), -1)::int as "maxPos" from google_maps_queries where audience_id = ${list.id}`
    )) as unknown as Array<{ maxPos: number }>;
    await db
      .insert(googleMapsQueries)
      .values(added.map((query, i) => ({ orgId: list.orgId, audienceId: list.id, position: maxPos + 1 + i, query, coverageRound: round })))
      .onConflictDoNothing();
    await db
      .update(googleMapsCoverageRounds)
      .set({ status: "extended", reason: draft.reason || null, queries: added, decidedAt: new Date() })
      .where(eq(googleMapsCoverageRounds.id, claim.id));
    console.log(
      `[human-service] google_maps.coverage_extended audience=${list.id} round=${round} searches=${added.length} ceiling_hits=${facts.filter((f) => f.atCeiling).length} run=${identity.runId ?? "-"}`
    );
    return "extended";
  } catch (err) {
    await db.delete(googleMapsCoverageRounds).where(and(eq(googleMapsCoverageRounds.id, claim.id), eq(googleMapsCoverageRounds.status, "drafting")));
    throw err;
  }
}
