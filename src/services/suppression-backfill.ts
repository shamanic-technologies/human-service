// One-time suppression backfill (reversible ledger).
//
// Per-brand suppression went live on 2026-06-15 and has held perfectly since.
// It was never backfilled. The fleet had been contacting people for months
// before that, so every person emailed while the guard did not exist is
// invisible to the dedup: the gateway re-serves them, and the brand re-pays a
// provider to re-reveal an email it already owns and already used recently.
//
// Backfilling a person = INSERTING their silver `brand_suppressions` row, the
// single surface every serve path reads (teaser filter, apify exclude-set,
// resolve-email block, and the audiences Remaining rollup). Nothing about how
// serving or suppression works changes — this is data repair.
//
// `last_served_at` is set to the moment they were ACTUALLY EMAILED, never to
// now(). That is what makes the repair say "suppressed for the REMAINDER of
// their window, exactly as if the guard had been live at the time" instead of
// silently granting every backfilled person a fresh three months. The window
// itself is untouched: the same `windowCutoff()` every read path already uses
// decides what is still suppressed.
//
// The set is "was actually EMAILED", NOT "was served". A serve the vendor never
// contacted is precisely what src/services/suppression-recovery.ts exists to
// repair, so backfilling bare serves would re-break it at scale. Evidence of
// what was actually SENT lives with the service that submitted to the vendor —
// this service cannot infer it and deliberately does not try. So, exactly like
// the recovery module: NO detector, NO sweep, NO inference. The caller supplies
// the exact set with a real send timestamp per entry.
//
// Every row the repair creates is recorded in `suppression_backfills`, tagged
// with the incident `reason`, which makes it:
//   - identifiable — `SELECT ... WHERE reason = '<tag>'`
//   - reversible   — `revertSentSuppressionBackfill` deletes exactly those rows
//   - idempotent   — unique (reason, org, brand, email_norm); a re-run counts
//                    already-backfilled entries and writes nothing new
//
// Bronze `lead_serves` is deliberately UNTOUCHED: it is the append-only audit of
// what the GATEWAY emitted, and a send it never made is not its to record.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandSuppressions, suppressionBackfills } from "../db/schema.js";
import { normalizeEmail, windowCutoff } from "./suppression.js";

export interface SentEntry {
  orgId: string;
  brandId: string;
  email: string;
  /** When the person was ACTUALLY emailed (ISO 8601). Never inferred here. */
  sentAt: string;
}

interface WantedRow {
  orgId: string;
  brandId: string;
  emailNorm: string;
  sentAt: Date;
}

export interface BackfillResult {
  dryRun: boolean;
  reason: string;
  requested: number;
  /** Distinct (org, brand, email_norm) keys — the grain the silver table is unique on. */
  distinct: number;
  /** Suppression rows created (0 on a dry-run — see `wouldBackfill`). */
  backfilled: number;
  /** Entries with no live suppression row and no prior backfill: the set this run acts on. */
  wouldBackfill: number;
  /**
   * Of `wouldBackfill`, those whose send is still inside the live three-month
   * window — i.e. the ones that actually stop a re-serve today. The rest are
   * written truthfully but suppress nothing (their window already lapsed).
   */
  wouldSuppressNow: number;
  /** Entries already backfilled under this reason — a re-run acts on none of them. */
  alreadyBackfilled: number;
  /** Entries that already hold a live suppression row: never touched, never re-dated. */
  alreadySuppressed: number;
  /** Per-brand `wouldBackfill` breakdown, so a dry-run states what it would touch. */
  byBrand: { brandId: string; count: number; withinWindow: number }[];
  /** Preview of the acted-on set (capped). */
  sample: { orgId: string; brandId: string; emailNorm: string; sentAt: string }[];
}

export interface RevertBackfillResult {
  dryRun: boolean;
  reason: string;
  /** Ledger rows carrying this `reason`. */
  ledgerRows: number;
  /** Suppression rows deleted (0 on a dry-run — see `wouldRemove`). */
  removed: number;
  wouldRemove: number;
  /**
   * Backfilled rows re-served since (their `last_served_at` moved past the
   * recorded `sent_at`). That row now records a REAL serve, so it is kept —
   * deleting it would re-open a person the gateway has genuinely emitted.
   */
  skippedReserved: number;
  /** Ledger rows whose suppression row is already gone (e.g. a recovery removed it). */
  alreadyRemoved: number;
}

const SAMPLE_LIMIT = 20;

function keyOf(e: { orgId: string; brandId: string; emailNorm: string }): string {
  return `${e.orgId}|${e.brandId}|${e.emailNorm}`;
}

/**
 * Suppress the caller-supplied set of people who were ACTUALLY EMAILED before
 * the guard existed, each for the remainder of their own three-month window.
 *
 * Idempotent (already-backfilled entries are counted, not re-applied), reversible
 * (`revertSentSuppressionBackfill`), dry-runnable (`dryRun` writes nothing and
 * reports exactly what a real run would create).
 */
export async function backfillSentSuppressions(
  reason: string,
  entries: SentEntry[],
  opts: { dryRun: boolean }
): Promise<BackfillResult> {
  // Normalize + dedup on the same key the silver table is unique on. When one
  // person was emailed several times for a brand, the LATEST send is the one
  // that decides how much of their window remains.
  const byKey = new Map<string, WantedRow>();
  for (const e of entries) {
    const emailNorm = normalizeEmail(e.email);
    // Fail loud rather than silently dropping a caller's entry.
    if (emailNorm === null) {
      throw new Error(
        `backfillSentSuppressions: blank email in entry for brand ${e.brandId}`
      );
    }
    const sentAt = new Date(e.sentAt);
    if (Number.isNaN(sentAt.getTime())) {
      throw new Error(
        `backfillSentSuppressions: unparseable sentAt "${e.sentAt}" for ${emailNorm} / brand ${e.brandId}`
      );
    }
    const row: WantedRow = { orgId: e.orgId, brandId: e.brandId, emailNorm, sentAt };
    const existing = byKey.get(keyOf(row));
    if (!existing || existing.sentAt < sentAt) byKey.set(keyOf(row), row);
  }
  const wanted = [...byKey.values()];

  const result: BackfillResult = {
    dryRun: opts.dryRun,
    reason,
    requested: entries.length,
    distinct: wanted.length,
    backfilled: 0,
    wouldBackfill: 0,
    wouldSuppressNow: 0,
    alreadyBackfilled: 0,
    alreadySuppressed: 0,
    byBrand: [],
    sample: [],
  };
  if (wanted.length === 0) return result;

  const orgIds = [...new Set(wanted.map((w) => w.orgId))];
  const brandIds = [...new Set(wanted.map((w) => w.brandId))];
  const emailNorms = [...new Set(wanted.map((w) => w.emailNorm))];

  // One coarse read per table (org x brand x email supersets), then intersect in
  // memory on the exact key — avoids a per-entry round-trip storm.
  const liveRows = await db
    .select({
      orgId: brandSuppressions.orgId,
      brandId: brandSuppressions.brandId,
      emailNorm: brandSuppressions.emailNorm,
    })
    .from(brandSuppressions)
    .where(
      and(
        inArray(brandSuppressions.orgId, orgIds),
        inArray(brandSuppressions.brandId, brandIds),
        inArray(brandSuppressions.emailNorm, emailNorms)
      )
    );

  const ledgerRows = await db
    .select({
      orgId: suppressionBackfills.orgId,
      brandId: suppressionBackfills.brandId,
      emailNorm: suppressionBackfills.emailNorm,
    })
    .from(suppressionBackfills)
    .where(
      and(
        eq(suppressionBackfills.reason, reason),
        inArray(suppressionBackfills.orgId, orgIds),
        inArray(suppressionBackfills.brandId, brandIds),
        inArray(suppressionBackfills.emailNorm, emailNorms)
      )
    );

  const wantedKeys = new Set(wanted.map(keyOf));
  const liveKeys = new Set(liveRows.map(keyOf).filter((k) => wantedKeys.has(k)));
  const ledgerKeys = new Set(
    ledgerRows.map(keyOf).filter((k) => wantedKeys.has(k))
  );

  // A person who already holds a suppression row is LEFT ALONE — re-dating a
  // live row would move a window we do not own. Same for one this reason has
  // already backfilled (idempotency).
  const toWrite = wanted.filter(
    (w) => !liveKeys.has(keyOf(w)) && !ledgerKeys.has(keyOf(w))
  );

  // The live cutoff, evaluated by Postgres from the ONE expression that defines
  // the re-contact window, so this count can never disagree with what the serve
  // paths enforce — and so nothing here re-states the window itself.
  const cutoffRows = (await db.execute(
    sql`select ${windowCutoff()} as cutoff`
  )) as unknown as { cutoff: Date | string }[];
  const cutoff = new Date(cutoffRows[0].cutoff);
  const withinWindow = (w: WantedRow) => w.sentAt > cutoff;

  const byBrandCounts = new Map<string, { count: number; withinWindow: number }>();
  for (const w of toWrite) {
    const cur = byBrandCounts.get(w.brandId) ?? { count: 0, withinWindow: 0 };
    cur.count += 1;
    if (withinWindow(w)) cur.withinWindow += 1;
    byBrandCounts.set(w.brandId, cur);
  }

  result.wouldBackfill = toWrite.length;
  result.wouldSuppressNow = toWrite.filter(withinWindow).length;
  result.alreadyBackfilled = ledgerKeys.size;
  result.alreadySuppressed = wanted.filter(
    (w) => liveKeys.has(keyOf(w)) && !ledgerKeys.has(keyOf(w))
  ).length;
  result.byBrand = [...byBrandCounts.entries()]
    .map(([brandId, c]) => ({ brandId, count: c.count, withinWindow: c.withinWindow }))
    .sort((a, b) => b.count - a.count);
  result.sample = toWrite.slice(0, SAMPLE_LIMIT).map((w) => ({
    orgId: w.orgId,
    brandId: w.brandId,
    emailNorm: w.emailNorm,
    sentAt: w.sentAt.toISOString(),
  }));

  if (opts.dryRun || toWrite.length === 0) return result;

  // Insert-then-record in ONE transaction: a suppression row can never be
  // created without its ledger entry existing, so the repair is always
  // identifiable and always undoable.
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(brandSuppressions)
      .values(
        toWrite.map((w) => ({
          orgId: w.orgId,
          brandId: w.brandId,
          emailNorm: w.emailNorm,
          // Unknown by construction: the caller knows a send happened, not
          // which provider sourced the person. Never invented.
          linkedinUrlNorm: null,
          providerPersonId: null,
          lastProvider: null,
          firstServedAt: w.sentAt,
          lastServedAt: w.sentAt,
        }))
      )
      // A concurrent serve could have suppressed the same key between the read
      // above and this write: that row is the truthful one, so it wins and this
      // entry simply drops out of the ledger too.
      .onConflictDoNothing()
      .returning({
        id: brandSuppressions.id,
        orgId: brandSuppressions.orgId,
        brandId: brandSuppressions.brandId,
        emailNorm: brandSuppressions.emailNorm,
        lastServedAt: brandSuppressions.lastServedAt,
      });

    if (inserted.length > 0) {
      await tx.insert(suppressionBackfills).values(
        inserted.map((r) => ({
          reason,
          suppressionId: r.id,
          orgId: r.orgId,
          brandId: r.brandId,
          emailNorm: r.emailNorm,
          sentAt: r.lastServedAt,
        }))
      );
    }
    result.backfilled = inserted.length;
  });

  return result;
}

/**
 * Undo a backfill: delete every `brand_suppressions` row this `reason` created,
 * then drop the ledger rows — returning the DB to its pre-repair state.
 *
 * A row whose `last_served_at` has moved past the recorded `sent_at` has been
 * re-served since: it now records a REAL emission, so it is KEPT (counted as
 * `skippedReserved`) — deleting it would re-open a person the gateway has
 * genuinely served.
 */
export async function revertSentSuppressionBackfill(
  reason: string,
  opts: { dryRun: boolean }
): Promise<RevertBackfillResult> {
  const ledger = await db
    .select()
    .from(suppressionBackfills)
    .where(eq(suppressionBackfills.reason, reason));

  const result: RevertBackfillResult = {
    dryRun: opts.dryRun,
    reason,
    ledgerRows: ledger.length,
    removed: 0,
    wouldRemove: 0,
    skippedReserved: 0,
    alreadyRemoved: 0,
  };
  if (ledger.length === 0) return result;

  const live = await db
    .select({
      id: brandSuppressions.id,
      lastServedAt: brandSuppressions.lastServedAt,
    })
    .from(brandSuppressions)
    .where(
      inArray(
        brandSuppressions.id,
        ledger.map((l) => l.suppressionId)
      )
    );
  const liveById = new Map(live.map((r) => [r.id, r]));

  const toRemove: string[] = [];
  for (const l of ledger) {
    const row = liveById.get(l.suppressionId);
    if (!row) {
      result.alreadyRemoved += 1;
      continue;
    }
    if (row.lastServedAt.getTime() !== l.sentAt.getTime()) {
      result.skippedReserved += 1;
      continue;
    }
    toRemove.push(l.suppressionId);
  }
  result.wouldRemove = toRemove.length;
  if (opts.dryRun) return result;

  await db.transaction(async (tx) => {
    if (toRemove.length > 0) {
      await tx
        .delete(brandSuppressions)
        .where(inArray(brandSuppressions.id, toRemove));
    }
    await tx
      .delete(suppressionBackfills)
      .where(eq(suppressionBackfills.reason, reason));
  });

  result.removed = toRemove.length;
  return result;
}
