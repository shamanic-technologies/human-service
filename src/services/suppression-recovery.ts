// One-time suppression recovery (reversible ledger).
//
// A serve is recorded the moment the gateway hands a person back with a verified
// email, which is correct: the gateway did emit them. But when the downstream
// send never reaches the vendor, that person is permanently un-emittable for the
// brand while nothing was ever sent to them — the brand paid for a prospect it
// can no longer reach.
//
// Recovering a person = DELETING their silver `brand_suppressions` row, which is
// the only surface the serve paths read (teaser filter, apify exclude-set,
// resolve-email block, and the audiences Remaining rollup all query it). Nothing
// about how serving or suppression works changes — this is data repair.
//
// Every deleted row is archived VERBATIM into `suppression_recoveries` first,
// tagged with the incident `reason`, which is what makes the repair:
//   - identifiable — `SELECT ... WHERE reason = '<tag>'`
//   - reversible   — `revertSuppressionRecovery` restores the archived rows
//   - idempotent   — unique (reason, org, brand, email_norm); a re-run counts
//                    already-recovered entries instead of re-applying them
//
// Bronze `lead_serves` is deliberately UNTOUCHED: it is the append-only audit of
// what the gateway actually emitted and it stays true. A future silver rebuild
// from bronze must consult this ledger.
//
// NOT a sweep and NOT a detector: the caller supplies the exact set, because
// "was this person actually handed to the vendor?" is knowable only by the
// service that submitted to the vendor — never inferable here.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandSuppressions, suppressionRecoveries } from "../db/schema.js";
import { normalizeEmail } from "./suppression.js";

export interface RecoveryEntry {
  orgId: string;
  brandId: string;
  email: string;
}

export interface RecoveryResult {
  dryRun: boolean;
  reason: string;
  requested: number;
  /** Distinct (org, brand, email_norm) keys after normalization + dedup. */
  distinct: number;
  /** Suppression rows deleted + archived (0 on a dry-run — see `wouldRecover`). */
  recovered: number;
  /** Entries that hold a live suppression row, i.e. the set this run acts on. */
  wouldRecover: number;
  /** Entries already archived under this `reason` — a re-run is a no-op on them. */
  alreadyRecovered: number;
  /** Entries with no suppression row and no prior archive: nothing to recover. */
  notSuppressed: number;
  /** Per-brand `wouldRecover` breakdown, so a dry-run states what it would touch. */
  byBrand: { brandId: string; count: number }[];
  /** Preview of the acted-on set (capped). */
  sample: { orgId: string; brandId: string; emailNorm: string }[];
}

export interface RevertResult {
  dryRun: boolean;
  reason: string;
  /** Ledger rows carrying this `reason`. */
  archived: number;
  /** Suppression rows re-inserted (0 on a dry-run — see `wouldRestore`). */
  restored: number;
  wouldRestore: number;
  /**
   * Archived entries whose (org, brand, email_norm) has since been suppressed
   * again by a fresh serve. The newer row WINS (never clobbered); the ledger row
   * is still dropped, because the end state — suppressed — is what a revert asks
   * for.
   */
  skippedResuppressed: number;
}

const SAMPLE_LIMIT = 20;

function keyOf(e: { orgId: string; brandId: string; emailNorm: string }): string {
  return `${e.orgId}|${e.brandId}|${e.emailNorm}`;
}

/**
 * Archive + delete the silver suppression rows for `entries`, tagged `reason`.
 *
 * Idempotent (already-archived entries are counted, not re-applied), reversible
 * (`revertSuppressionRecovery`), dry-runnable (`dryRun` writes nothing and
 * reports exactly what a real run would act on).
 */
export async function recoverSuppressions(
  reason: string,
  entries: RecoveryEntry[],
  opts: { dryRun: boolean }
): Promise<RecoveryResult> {
  // Normalize + dedup on the same key the silver table is unique on, so a
  // duplicated input entry can never double-count.
  const byKey = new Map<
    string,
    { orgId: string; brandId: string; emailNorm: string }
  >();
  for (const e of entries) {
    const emailNorm = normalizeEmail(e.email);
    // Fail loud rather than silently dropping a caller's entry.
    if (emailNorm === null) {
      throw new Error(`recoverSuppressions: blank email in entry for brand ${e.brandId}`);
    }
    const row = { orgId: e.orgId, brandId: e.brandId, emailNorm };
    byKey.set(keyOf(row), row);
  }
  const wanted = [...byKey.values()];

  const empty: RecoveryResult = {
    dryRun: opts.dryRun,
    reason,
    requested: entries.length,
    distinct: 0,
    recovered: 0,
    wouldRecover: 0,
    alreadyRecovered: 0,
    notSuppressed: 0,
    byBrand: [],
    sample: [],
  };
  if (wanted.length === 0) return empty;

  const orgIds = [...new Set(wanted.map((w) => w.orgId))];
  const brandIds = [...new Set(wanted.map((w) => w.brandId))];
  const emailNorms = [...new Set(wanted.map((w) => w.emailNorm))];

  // One coarse read per table (org x brand x email supersets), then intersect in
  // memory on the exact key — avoids a 169-statement round-trip storm.
  const liveRows = await db
    .select({
      id: brandSuppressions.id,
      orgId: brandSuppressions.orgId,
      brandId: brandSuppressions.brandId,
      emailNorm: brandSuppressions.emailNorm,
      linkedinUrlNorm: brandSuppressions.linkedinUrlNorm,
      providerPersonId: brandSuppressions.providerPersonId,
      lastProvider: brandSuppressions.lastProvider,
      firstServedAt: brandSuppressions.firstServedAt,
      lastServedAt: brandSuppressions.lastServedAt,
    })
    .from(brandSuppressions)
    .where(
      and(
        inArray(brandSuppressions.orgId, orgIds),
        inArray(brandSuppressions.brandId, brandIds),
        inArray(brandSuppressions.emailNorm, emailNorms)
      )
    );

  const archivedRows = await db
    .select({
      orgId: suppressionRecoveries.orgId,
      brandId: suppressionRecoveries.brandId,
      emailNorm: suppressionRecoveries.emailNorm,
    })
    .from(suppressionRecoveries)
    .where(
      and(
        eq(suppressionRecoveries.reason, reason),
        inArray(suppressionRecoveries.orgId, orgIds),
        inArray(suppressionRecoveries.brandId, brandIds),
        inArray(suppressionRecoveries.emailNorm, emailNorms)
      )
    );

  const wantedKeys = new Set(wanted.map(keyOf));
  const alreadyKeys = new Set(
    archivedRows.map(keyOf).filter((k) => wantedKeys.has(k))
  );
  const toRecover = liveRows.filter((r) => wantedKeys.has(keyOf(r)));
  const toRecoverKeys = new Set(toRecover.map(keyOf));

  const byBrandCounts = new Map<string, number>();
  for (const r of toRecover) {
    byBrandCounts.set(r.brandId, (byBrandCounts.get(r.brandId) ?? 0) + 1);
  }

  const result: RecoveryResult = {
    dryRun: opts.dryRun,
    reason,
    requested: entries.length,
    distinct: wanted.length,
    recovered: 0,
    wouldRecover: toRecover.length,
    alreadyRecovered: alreadyKeys.size,
    notSuppressed: wanted.filter(
      (w) => !toRecoverKeys.has(keyOf(w)) && !alreadyKeys.has(keyOf(w))
    ).length,
    byBrand: [...byBrandCounts.entries()]
      .map(([brandId, count]) => ({ brandId, count }))
      .sort((a, b) => b.count - a.count),
    sample: toRecover.slice(0, SAMPLE_LIMIT).map((r) => ({
      orgId: r.orgId,
      brandId: r.brandId,
      emailNorm: r.emailNorm,
    })),
  };

  if (opts.dryRun || toRecover.length === 0) return result;

  // Archive-then-delete in ONE transaction: a row can never be deleted without
  // its verbatim archive existing, so the repair is always revertible.
  await db.transaction(async (tx) => {
    await tx.insert(suppressionRecoveries).values(
      toRecover.map((r) => ({
        reason,
        suppressionId: r.id,
        orgId: r.orgId,
        brandId: r.brandId,
        emailNorm: r.emailNorm,
        linkedinUrlNorm: r.linkedinUrlNorm,
        providerPersonId: r.providerPersonId,
        lastProvider: r.lastProvider,
        firstServedAt: r.firstServedAt,
        lastServedAt: r.lastServedAt,
      }))
    );
    await tx.delete(brandSuppressions).where(
      inArray(
        brandSuppressions.id,
        toRecover.map((r) => r.id)
      )
    );
  });

  result.recovered = toRecover.length;
  return result;
}

/**
 * Undo a recovery: restore every archived suppression row carrying `reason`,
 * verbatim (same id, same first/last served timestamps), then drop the ledger
 * rows — returning the DB to its pre-repair state.
 *
 * A person suppressed again by a FRESH serve since the recovery keeps that newer
 * row (`onConflictDoNothing`); the end state is still "suppressed", which is what
 * the revert asks for.
 */
export async function revertSuppressionRecovery(
  reason: string,
  opts: { dryRun: boolean }
): Promise<RevertResult> {
  const archived = await db
    .select()
    .from(suppressionRecoveries)
    .where(eq(suppressionRecoveries.reason, reason));

  if (archived.length === 0) {
    return {
      dryRun: opts.dryRun,
      reason,
      archived: 0,
      restored: 0,
      wouldRestore: 0,
      skippedResuppressed: 0,
    };
  }

  const live = await db
    .select({
      orgId: brandSuppressions.orgId,
      brandId: brandSuppressions.brandId,
      emailNorm: brandSuppressions.emailNorm,
    })
    .from(brandSuppressions)
    .where(
      and(
        inArray(brandSuppressions.orgId, [
          ...new Set(archived.map((a) => a.orgId)),
        ]),
        inArray(brandSuppressions.brandId, [
          ...new Set(archived.map((a) => a.brandId)),
        ]),
        inArray(brandSuppressions.emailNorm, [
          ...new Set(archived.map((a) => a.emailNorm)),
        ])
      )
    );
  const liveKeys = new Set(live.map(keyOf));
  const toRestore = archived.filter((a) => !liveKeys.has(keyOf(a)));

  const result: RevertResult = {
    dryRun: opts.dryRun,
    reason,
    archived: archived.length,
    restored: 0,
    wouldRestore: toRestore.length,
    skippedResuppressed: archived.length - toRestore.length,
  };
  if (opts.dryRun) return result;

  await db.transaction(async (tx) => {
    if (toRestore.length > 0) {
      await tx
        .insert(brandSuppressions)
        .values(
          toRestore.map((a) => ({
            id: a.suppressionId,
            orgId: a.orgId,
            brandId: a.brandId,
            emailNorm: a.emailNorm,
            linkedinUrlNorm: a.linkedinUrlNorm,
            providerPersonId: a.providerPersonId,
            lastProvider: a.lastProvider,
            firstServedAt: a.firstServedAt,
            lastServedAt: a.lastServedAt,
          }))
        )
        .onConflictDoNothing();
    }
    await tx
      .delete(suppressionRecoveries)
      .where(eq(suppressionRecoveries.reason, reason));
  });

  result.restored = toRestore.length;
  return result;
}
