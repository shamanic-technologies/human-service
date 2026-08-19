// One-time repair: give every pre-existing audience the offer it belongs to.
//
// #221 gave the audiences table its `offer_id` grain and #223 let a suggestion
// state it, so every audience born after those ships carries an offer. Every row
// created BEFORE them carries none — and the customer dashboard's Audiences page
// now lives under an offer and asks for that offer's audiences, so those rows
// are invisible to the only Audiences surface a customer has.
//
// There is no attribution heuristic to design. An offer is per (org, brand), and
// an audience already carries both: brand-service resolves that pair to its
// offers, and where exactly one exists there is a single correct answer. Where
// none exists the audience STAYS NULL — absent means brand-wide, which is what
// the column documents, and inventing an offer would be worse than the gap. That
// residue is reported, never swallowed; it belongs to whoever owns the offer
// migration, not to this repair.
//
// Deliberately NOT used: outreach history, campaign links, name matching. The
// pair join is exact, so anything cleverer would be a heuristic solving a
// problem that does not exist.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences } from "../db/schema.js";
import {
  listBrandOffers,
  BrandConfigError,
  BrandServiceError,
} from "../lib/brand-offers.js";

// One (org, brand) pair and the offer-less audiences under it.
export interface OfferBackfillPair {
  orgId: string;
  brandId: string;
  audienceIds: string[];
}

// A row this sweep attributed (or would attribute). The full set is returned —
// not a sample — because it IS the reversal set: undoing the repair is
// `UPDATE audiences SET offer_id = NULL WHERE id IN (<these ids>)`.
export interface OfferAssignment {
  audienceId: string;
  name: string;
  orgId: string;
  brandId: string;
  offerId: string;
}

// A pair left alone, with the reason and how many audiences it costs. Both
// reasons are honest gaps, not failures of this repair: `no offer` means the
// (org, brand) holds none yet, `several offers` means there is no single correct
// answer and we never guess.
export interface OfferBackfillSkip {
  orgId: string;
  brandId: string;
  audiences: number;
  reason: string;
}

export interface OfferBackfillResult {
  dryRun: boolean;
  // Audiences with offer_id IS NULL inspected by this sweep.
  scanned: number;
  // Distinct (org, brand) pairs those audiences span — one brand-service read each.
  pairs: number;
  // Rows written (0 on a dry run — the would-be count is `wouldAttribute`).
  attributed: number;
  wouldAttribute: number;
  // Rows still carrying no offer after this sweep. The number that matters.
  unattributed: number;
  skipped: OfferBackfillSkip[];
  assignments: OfferAssignment[];
}

// Group the offer-less audiences by (org, brand) so brand-service is read once
// per pair rather than once per audience.
export async function loadOfferlessPairs(): Promise<{
  scanned: number;
  pairs: OfferBackfillPair[];
}> {
  const rows = await db
    .select({
      id: audiences.id,
      orgId: audiences.orgId,
      brandId: audiences.brandId,
    })
    .from(audiences)
    .where(isNull(audiences.offerId));

  const byPair = new Map<string, OfferBackfillPair>();
  for (const row of rows) {
    const key = `${row.orgId}::${row.brandId}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.audienceIds.push(row.id);
      continue;
    }
    byPair.set(key, {
      orgId: row.orgId,
      brandId: row.brandId,
      audienceIds: [row.id],
    });
  }

  return { scanned: rows.length, pairs: [...byPair.values()] };
}

// Attribute every offer-less audience whose (org, brand) resolves to exactly one
// offer. Idempotent (scoped to `offer_id IS NULL`, so a clean re-run attributes
// 0) and dry-runnable (resolves the same answers, writes nothing).
//
// A missing brand-service config aborts loudly (the whole sweep is meaningless
// without it). A per-pair brand-service failure is counted in `skipped` and its
// audiences stay null — a re-run picks them up, since they are still offer-less.
export async function backfillAudienceOffers(
  pairs: OfferBackfillPair[],
  scanned: number,
  opts: { dryRun: boolean }
): Promise<OfferBackfillResult> {
  const assignments: OfferAssignment[] = [];
  const skipped: OfferBackfillSkip[] = [];

  for (const pair of pairs) {
    let offers;
    try {
      offers = await listBrandOffers(pair.brandId, pair.orgId);
    } catch (err) {
      // No offers readable at all ⟹ nothing this sweep can do anywhere. Fail
      // loud rather than report a fleet of "no offer" gaps that are really a
      // misconfiguration.
      if (err instanceof BrandConfigError) throw err;
      const reason =
        err instanceof BrandServiceError
          ? `brand-service ${err.status}: ${err.message}`.slice(0, 200)
          : `brand-service error: ${String(err)}`.slice(0, 200);
      console.warn(
        `[human-service] backfill_offer.skip org=${pair.orgId} brand=${pair.brandId} ${reason}`
      );
      skipped.push({
        orgId: pair.orgId,
        brandId: pair.brandId,
        audiences: pair.audienceIds.length,
        reason,
      });
      continue;
    }

    if (offers.length === 0) {
      // The honest gap: this (org, brand) holds no offer. Absent means
      // brand-wide — leave it exactly as it is and report the count.
      skipped.push({
        orgId: pair.orgId,
        brandId: pair.brandId,
        audiences: pair.audienceIds.length,
        reason: "no offer",
      });
      continue;
    }

    if (offers.length > 1) {
      // More than one offer ⟹ no single correct answer. Never guess.
      skipped.push({
        orgId: pair.orgId,
        brandId: pair.brandId,
        audiences: pair.audienceIds.length,
        reason: `several offers (${offers.length})`,
      });
      continue;
    }

    const offerId = offers[0].offerId;

    if (opts.dryRun) {
      const rows = await db
        .select({ id: audiences.id, name: audiences.name })
        .from(audiences)
        .where(
          and(
            eq(audiences.orgId, pair.orgId),
            eq(audiences.brandId, pair.brandId),
            isNull(audiences.offerId)
          )
        );
      for (const row of rows) {
        assignments.push({
          audienceId: row.id,
          name: row.name,
          orgId: pair.orgId,
          brandId: pair.brandId,
          offerId,
        });
      }
      continue;
    }

    try {
      const written = await db
        .update(audiences)
        .set({ offerId, updatedAt: new Date() })
        .where(
          and(
            eq(audiences.orgId, pair.orgId),
            eq(audiences.brandId, pair.brandId),
            isNull(audiences.offerId)
          )
        )
        .returning({ id: audiences.id, name: audiences.name });

      for (const row of written) {
        // Logged per row so the reversal set survives the HTTP response.
        console.log(
          `[human-service] backfill_offer.set audience=${row.id} offer=${offerId} org=${pair.orgId} brand=${pair.brandId}`
        );
        assignments.push({
          audienceId: row.id,
          name: row.name,
          orgId: pair.orgId,
          brandId: pair.brandId,
          offerId,
        });
      }
    } catch (err) {
      const reason = `write failed: ${err instanceof Error ? err.message : String(err)}`.slice(
        0,
        200
      );
      console.error(
        `[human-service] backfill_offer.write_failed org=${pair.orgId} brand=${pair.brandId} ${reason}`
      );
      skipped.push({
        orgId: pair.orgId,
        brandId: pair.brandId,
        audiences: pair.audienceIds.length,
        reason,
      });
    }
  }

  const wouldAttribute = assignments.length;
  return {
    dryRun: opts.dryRun,
    scanned,
    pairs: pairs.length,
    attributed: opts.dryRun ? 0 : wouldAttribute,
    wouldAttribute,
    unattributed: scanned - wouldAttribute,
    skipped,
    assignments,
  };
}
