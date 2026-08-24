// Attribute offer-less audiences on THIS service's own cadence, so a row born
// before its brand's offer existed does not wait for a human to remember the
// one-shot sweep.
//
// Why this exists: onboarding suggests audiences at its `audiences` step, which
// runs BEFORE the write that creates the brand's offer. So a brand signing up
// today has no offer at the moment its audiences are written, they are born
// brand-wide, and the customer's only Audiences surface — an offer page — is
// empty until someone POSTs `/internal/backfill-audience-offers` by hand. The
// write path is not what was missing (#223 lets a suggestion state its offer);
// what was missing is that a row born offer-less is never revisited.
//
// This is about WHEN the repair runs, not about what it is willing to guess.
// The resolution rule is UNCHANGED and lives in `audience-offer-backfill.ts`:
// an offer is per (org, brand), never per brand; a pair with no offer, or with
// several, has no correct answer and stays null, counted rather than swallowed.
//
// Boot safety: NOTHING here is awaited before `app.listen()`. The first tick is
// deliberately delayed and each tick is fire-and-forget, so the O(pairs)
// brand-service reads can never delay port-bind or fail a deploy healthcheck.

import { getMigrationState } from "../lib/migration-state.js";
import { BrandConfigError } from "../lib/brand-offers.js";
import {
  backfillAudienceOffers,
  loadOfferlessPairs,
  type OfferBackfillResult,
} from "./audience-offer-backfill.js";

// How long after boot the first sweep runs. Long enough for migrations to land
// and for the sibling fleet to finish coming up after a box-wide restart; short
// enough that a deploy visibly repairs the data.
const DEFAULT_INITIAL_DELAY_MS = 60_000;
// How often it runs afterwards. An offer created minutes after a signup's
// audiences is picked up on the next tick — a bounded, small staleness rather
// than "whenever someone notices".
const DEFAULT_INTERVAL_MS = 15 * 60_000;

function readMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[human-service] offer_sweep.bad_env ${name}=${raw} — using ${fallback}`
    );
    return fallback;
  }
  return parsed;
}

// Guards against a slow sweep overlapping the next tick: the sweep is scoped to
// `offer_id IS NULL`, so two concurrent runs would read the same pairs and issue
// the same brand-service reads for nothing.
let running = false;

/**
 * One sweep. Returns the result, or null when the tick was skipped (schema not
 * ready, brand-service unconfigured, or a previous tick still running) — a skip
 * is never an error: the next tick picks the same rows up, since they are still
 * offer-less.
 */
export async function runOfferAttributionSweep(): Promise<OfferBackfillResult | null> {
  if (running) {
    console.log("[human-service] offer_sweep.skip reason=already_running");
    return null;
  }
  // The port is open before migrations land; every DB-backed route is 503 in
  // that window and this background worker honours the same gate.
  const migrations = getMigrationState();
  if (migrations !== "ready") {
    console.log(`[human-service] offer_sweep.skip reason=migrations_${migrations}`);
    return null;
  }

  running = true;
  try {
    const { scanned, pairs } = await loadOfferlessPairs();
    if (pairs.length === 0) {
      // Every audience already carries the offer it belongs to. Nothing to do,
      // and no brand-service read issued.
      return {
        dryRun: false,
        scanned,
        pairs: 0,
        attributed: 0,
        wouldAttribute: 0,
        unattributed: scanned,
        skipped: [],
        assignments: [],
      };
    }

    const result = await backfillAudienceOffers(pairs, scanned, { dryRun: false });
    console.log(
      `[human-service] offer_sweep.run scanned=${result.scanned} pairs=${result.pairs} attributed=${result.attributed} unattributed=${result.unattributed} skippedPairs=${result.skipped.length}`
    );
    return result;
  } catch (err) {
    // Loud, never fatal. A missing BRAND_SERVICE_* config means no offer is
    // readable anywhere, so the sweep is meaningless this tick — it must NOT
    // take the process down, and it must not silently look like "no gaps".
    if (err instanceof BrandConfigError) {
      console.error(
        `[human-service] offer_sweep.unconfigured ${err.message} — no audience attributed this tick`
      );
      return null;
    }
    console.error("[human-service] offer_sweep.failed", err);
    return null;
  } finally {
    running = false;
  }
}

/**
 * Arm the recurring sweep. Fire-and-forget by construction: it schedules timers
 * and returns immediately, so it can be called right after `app.listen()`
 * without delaying port-bind. Returns a stop function.
 *
 * `OFFER_ATTRIBUTION_SWEEP_INTERVAL_MS=0` disables it entirely (kill switch).
 */
export function startOfferAttributionSweep(): () => void {
  const intervalMs = readMs("OFFER_ATTRIBUTION_SWEEP_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  if (intervalMs === 0) {
    console.log("[human-service] offer_sweep.disabled interval=0");
    return () => {};
  }
  const initialDelayMs = readMs(
    "OFFER_ATTRIBUTION_SWEEP_INITIAL_DELAY_MS",
    DEFAULT_INITIAL_DELAY_MS
  );

  console.log(
    `[human-service] offer_sweep.armed initialDelayMs=${initialDelayMs} intervalMs=${intervalMs}`
  );

  const timers: NodeJS.Timeout[] = [];
  const tick = () => {
    void runOfferAttributionSweep();
  };

  const first = setTimeout(() => {
    tick();
    const repeat = setInterval(tick, intervalMs);
    // Never hold the event loop open on account of this worker.
    repeat.unref?.();
    timers.push(repeat);
  }, initialDelayMs);
  first.unref?.();
  timers.push(first);

  return () => {
    for (const t of timers) clearTimeout(t as unknown as NodeJS.Timeout);
    for (const t of timers) clearInterval(t as unknown as NodeJS.Timeout);
    timers.length = 0;
  };
}
