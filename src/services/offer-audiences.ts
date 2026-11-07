// ONE AUDIENCE PER OFFER (AUDIENCE-PER-OFFER-1107, owner 2026-11-07).
//
// An offer has exactly ONE audience: a plain-language text of who it targets (the
// offer's own text, held by brand-service). The LISTS that find people (Apollo
// searches, buying signals, competitor-post engagement) belong to the BRAND, not
// to an offer: every offer of the brand walks them, and Jev (lead-service's
// pre-pay screen, on the candidate path) judges each person against THIS offer's
// text. A person one offer declines stays in the brand's list for the others.
//
//   role = 'target' : THE audience of its offer. Text only, no list of its own.
//                     Listed like any audience; served only through candidates.
//   role = 'search' : a list of the brand (a former audience row, its filters /
//                     pointer, cursor, buffer and sources intact). Hidden from the
//                     audience list by default (`?role=search` shows them); walked
//                     by every target of its brand.
//   role IS NULL    : an audience as before. Nothing about it changed.
//
// THE SHARED WALK. A target's walk reads a brand list's buffered teasers WITHOUT
// consuming them: a teaser this target already decided (a candidate row, or a
// rejection) is skipped, one no target can ever take (taken for the brand, opted
// out, bounced, own company, no facts about the person) is deleted. The search's
// cursor advances for every target alike. Candidates, decisions and yield are on
// the TARGET; the candidate records which list found it.
//
// CRM lists (files, people pool) are walked through crm-service's HAND-OUTS (v0.121.0):
// a contact handed to one offer audience is burned for the brand only when that
// offer serves it; a decline leaves it to the brand's other offers.
//
// REALIGNMENT (`POST /internal/offer-audiences/realign`): creates each offer's
// target from its text and turns the given audience rows into searches, in one
// transaction, recorded in `offer_audience_realignments` under a reason tag so
// `/revert` undoes exactly that. Nothing archived or deleted.

import { and, eq, inArray, ne } from "drizzle-orm";
import { providerCanReach, type Reach } from "../lib/reach.js";
import { db, sql as pg } from "../db/index.js";
import { audiences, offerAudienceRealignments, type AudienceSource } from "../db/schema.js";
import type { PoppedTeaserRow } from "./teaser-buffer.js";
import { audienceListKind } from "./audience-snapshot.js";
import { isSourceOn, ownListOn, sourcesOf, sourceView, SOURCE_EXHAUSTED_RETRY_MS } from "./audience-sources.js";
import { isCrmSourcedFeature, listKindOfOriginSlug, type AudienceListKind } from "./sourcing-origin.js";
import { LEAD_SOURCING_SLUG, readLeadSourcingChoice } from "./lead-sourcing.js";
import { systemStatus } from "./audience-status-origin.js";

type AudienceRow = typeof audiences.$inferSelect;

export const OFFER_AUDIENCE_SOURCE_TAG = "offer_audience";

export function isOfferTarget(a: Pick<AudienceRow, "role">): boolean {
  return a.role === "target";
}

export function isBrandSearch(a: Pick<AudienceRow, "role">): boolean {
  return a.role === "search";
}

/** One list of the brand a target walks: the search row, the source of it (null = its own list), the serve view. */
export interface BrandList {
  search: AudienceRow;
  source: AudienceSource | null;
  view: AudienceRow;
  list: AudienceListKind;
}

const WALKABLE_LISTS: ReadonlySet<AudienceListKind> = new Set([
  "apollo_search",
  "apollo_buying_signal",
  "linkedin_engagement",
  "crm_contacts",
]);

function hasOwnList(row: AudienceRow): boolean {
  const filters = row.filters as Record<string, unknown> | null;
  return !!row.apolloAudienceId || (!!filters && Object.keys(filters).length > 0);
}

/**
 * The brand lists a target walks for a serve under `featureSlug`, in walk order:
 *   - every ACTIVE search of the target's (org, brand): its own list when on and
 *     built, plus each of its ON sources (CRM files excluded, see header);
 *   - an origin slug ⟹ only the lists of that kind; `lead-sourcing` ⟹ only the
 *     kinds the offer's stored choice picked (no choice ⟹ every list);
 *   - random order (each list its share), the ones walked out recently last.
 */
export async function brandListsOf(
  target: AudienceRow,
  featureSlug: string | undefined,
  reach: readonly Reach[] = [],
  random: () => number = Math.random
): Promise<BrandList[]> {
  const searches = await db
    .select()
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, target.orgId),
        eq(audiences.brandId, target.brandId),
        eq(audiences.role, "search"),
        eq(audiences.status, "active"),
        inArray(audiences.provider, ["apollo", "crm"])
      )
    );
  const sources = await sourcesOf(searches.map((s) => s.id));
  const all: BrandList[] = [];
  for (const search of searches) {
    const own = audienceListKind(search);
    if (search.provider === "crm") {
      if (ownListOn(search) && providerCanReach("crm", reach)) all.push({ search, source: null, view: search, list: "crm_contacts" });
      continue;
    }
    if (!providerCanReach("apollo", reach)) continue;
    if (own && WALKABLE_LISTS.has(own) && ownListOn(search) && hasOwnList(search)) {
      all.push({ search, source: null, view: search, list: own });
    }
    for (const source of sources.get(search.id) ?? []) {
      const list = source.list as AudienceListKind;
      if (!isSourceOn(source) || !WALKABLE_LISTS.has(list)) continue;
      all.push({ search, source, view: sourceView(search, source), list });
    }
  }
  const wanted = await wantedLists(target, featureSlug);
  const kept = wanted ? all.filter((l) => wanted.has(l.list)) : all;
  const now = Date.now();
  const spent = (l: BrandList) => {
    const at = l.source ? l.source.exhaustedAt : null;
    return !!at && now - at.getTime() < SOURCE_EXHAUSTED_RETRY_MS;
  };
  const shuffled = kept.map((l) => ({ l, k: random() })).sort((a, b) => a.k - b.k).map((x) => x.l);
  return [...shuffled.filter((l) => !spent(l)), ...shuffled.filter(spent)];
}

async function wantedLists(target: AudienceRow, featureSlug: string | undefined): Promise<Set<AudienceListKind> | null> {
  if (!featureSlug) return null;
  if (isCrmSourcedFeature(featureSlug)) return new Set<AudienceListKind>(["crm_contacts"]);
  if (featureSlug === LEAD_SOURCING_SLUG) {
    if (!target.offerId) return null;
    const choice = await readLeadSourcingChoice({ orgId: target.orgId, brandId: target.brandId, offerId: target.offerId });
    if (!choice) return null;
    const out = new Set<AudienceListKind>();
    for (const slug of choice.chosenOriginSlugs) {
      const list = await listKindOfOriginSlug(slug);
      if (list) out.add(list);
    }
    return out;
  }
  const list = await listKindOfOriginSlug(featureSlug);
  // An outreach slug (not an origin) asks no particular list: every list.
  return list ? new Set([list]) : null;
}

// ─── Realignment ─────────────────────────────────────────────────────────────

export interface RealignInput {
  reason: string;
  orgId: string;
  brandId: string;
  offers: Array<{ offerId: string; name: string; text: string }>;
  searchAudienceIds: string[];
  dryRun: boolean;
}

export interface RealignResult {
  dryRun: boolean;
  targets: Array<{ offerId: string; audienceId: string | null; outcome: "created" | "would_create" | "exists" }>;
  searches: Array<{ audienceId: string; outcome: "made_search" | "would_make_search" | "already_search" }>;
}

export class RealignError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function realignOfferAudiences(input: RealignInput): Promise<RealignResult> {
  const { orgId, brandId } = input;
  const ids = [...new Set(input.searchAudienceIds)];
  const rows = ids.length
    ? await db
        .select()
        .from(audiences)
        .where(and(eq(audiences.orgId, orgId), eq(audiences.brandId, brandId), inArray(audiences.id, ids)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new RealignError(`audiences not in this org and brand: ${missing.join(", ")}`, 404);
  const bad = rows.filter((r) => r.status === "deprecated" || isOfferTarget(r));
  if (bad.length) throw new RealignError(`cannot make a search of a deprecated or target audience: ${bad.map((r) => r.id).join(", ")}`, 400);
  const offerIds = input.offers.map((o) => o.offerId);
  if (new Set(offerIds).size !== offerIds.length) throw new RealignError("one entry per offer", 400);

  return db.transaction(async (tx) => {
    const existingTargets = offerIds.length
      ? await tx
          .select()
          .from(audiences)
          .where(
            and(
              eq(audiences.orgId, orgId),
              eq(audiences.brandId, brandId),
              eq(audiences.role, "target"),
              ne(audiences.status, "deprecated"),
              inArray(audiences.offerId, offerIds)
            )
          )
      : [];
    const targetOf = new Map(existingTargets.map((t) => [t.offerId!, t]));
    const result: RealignResult = { dryRun: input.dryRun, targets: [], searches: [] };

    for (const offer of input.offers) {
      const existing = targetOf.get(offer.offerId);
      if (existing) {
        result.targets.push({ offerId: offer.offerId, audienceId: existing.id, outcome: "exists" });
        continue;
      }
      if (input.dryRun) {
        result.targets.push({ offerId: offer.offerId, audienceId: null, outcome: "would_create" });
        continue;
      }
      const [created] = await tx
        .insert(audiences)
        .values({
          orgId,
          brandId,
          offerId: offer.offerId,
          name: offer.name,
          nlPrompt: offer.text,
          targetText: offer.text,
          targetTextOrigin: "audience_target",
          provider: "apollo",
          role: "target",
          status: "active",
          source: OFFER_AUDIENCE_SOURCE_TAG,
          ...systemStatus("offer_audience"),
        })
        .returning();
      await tx.insert(offerAudienceRealignments).values({
        reason: input.reason,
        orgId,
        brandId,
        audienceId: created.id,
        action: "target_created",
        previousRole: null,
      });
      result.targets.push({ offerId: offer.offerId, audienceId: created.id, outcome: "created" });
    }

    for (const id of ids) {
      const row = byId.get(id)!;
      if (isBrandSearch(row)) {
        result.searches.push({ audienceId: id, outcome: "already_search" });
        continue;
      }
      if (input.dryRun) {
        result.searches.push({ audienceId: id, outcome: "would_make_search" });
        continue;
      }
      await tx.update(audiences).set({ role: "search", updatedAt: new Date() }).where(eq(audiences.id, id));
      await tx
        .insert(offerAudienceRealignments)
        .values({ reason: input.reason, orgId, brandId, audienceId: id, action: "made_search", previousRole: row.role ?? null })
        .onConflictDoNothing();
      result.searches.push({ audienceId: id, outcome: "made_search" });
    }
    console.log(
      `[human-service] offer_audiences.realign org=${orgId} brand=${brandId} reason=${input.reason} dryRun=${input.dryRun} targets=${JSON.stringify(result.targets.map((t) => t.outcome))} searches=${result.searches.length}`
    );
    return result;
  });
}

/** Undo one realignment: searches get their previous role back, the targets it created are deprecated. */
export async function revertOfferAudienceRealignment(reason: string): Promise<{ restoredSearches: number; deprecatedTargets: number }> {
  return db.transaction(async (tx) => {
    const ledger = await tx.select().from(offerAudienceRealignments).where(eq(offerAudienceRealignments.reason, reason));
    let restoredSearches = 0;
    let deprecatedTargets = 0;
    for (const row of ledger) {
      if (row.action === "made_search") {
        await tx
          .update(audiences)
          .set({ role: (row.previousRole as AudienceRow["role"]) ?? null, updatedAt: new Date() })
          .where(and(eq(audiences.id, row.audienceId), eq(audiences.role, "search")));
        restoredSearches += 1;
      } else if (row.action === "target_created") {
        await tx
          .update(audiences)
          .set({ status: "deprecated", updatedAt: new Date(), ...systemStatus("offer_audience_reverted") })
          .where(eq(audiences.id, row.audienceId));
        deprecatedTargets += 1;
      }
    }
    await tx.delete(offerAudienceRealignments).where(eq(offerAudienceRealignments.reason, reason));
    console.log(
      `[human-service] offer_audiences.revert reason=${reason} restoredSearches=${restoredSearches} deprecatedTargets=${deprecatedTargets}`
    );
    return { restoredSearches, deprecatedTargets };
  });
}

// ─── The shared buffer ───────────────────────────────────────────────────────

/**
 * The oldest teaser of a brand list this target has not decided yet, NOT consumed
 * (another target of the brand may take the person).
 */
export async function peekTeaserForTarget(
  orgId: string,
  searchAudienceId: string,
  sourceId: string | null,
  targetId: string
): Promise<PoppedTeaserRow | null> {
  const ofSource = sourceId ? pg`AND b.source_id = ${sourceId}` : pg`AND b.source_id IS NULL`;
  const rows = await pg<
    {
      id: string;
      source_id: string | null;
      created_at: Date;
      provider_person_id: string;
      linkedin_url: string | null;
      teaser: PoppedTeaserRow["teaser"];
      organization_domain: string | null;
    }[]
  >`
    SELECT b.id, b.source_id, b.created_at, b.provider_person_id, b.linkedin_url, b.teaser, b.organization_domain
    FROM audience_teaser_buffer b
    WHERE b.org_id = ${orgId} AND b.audience_id = ${searchAudienceId} ${ofSource}
      AND NOT EXISTS (
        SELECT 1 FROM audience_candidates c
        WHERE c.audience_id = ${targetId} AND c.provider_person_id = b.provider_person_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM audience_screened_out s
        WHERE s.audience_id = ${targetId} AND s.provider_person_id = b.provider_person_id
      )
    ORDER BY b.created_at ASC
    LIMIT 1
  `;
  const r = rows[0];
  return r
    ? {
        id: r.id,
        orgId,
        audienceId: searchAudienceId,
        sourceId: r.source_id,
        createdAt: new Date(r.created_at),
        providerPersonId: r.provider_person_id,
        linkedinUrl: r.linkedin_url,
        teaser: r.teaser,
        organizationDomain: r.organization_domain,
      }
    : null;
}

/** A buffered teaser no target of the brand can ever take: gone from the list. */
export async function dropBufferedTeaser(id: string): Promise<void> {
  await pg`DELETE FROM audience_teaser_buffer WHERE id = ${id}`;
}

