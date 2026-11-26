// ONBOARDING-ONE-AUDIENCE-1126: every offer on ONE audience (offer-audiences.ts).
//
// Creation paths align their offer at write time (confirmAudienceSplit, widening accept). This sweep aligns
// what they cannot: offers that existed before (the owner's 2026-11-07 model was only applied to brands a staff
// realign moved by hand), a row activated later (a /suggest row PATCHed active, a staff create, a CRM file
// audience), and a creation whose brand-service read failed. Per (org, brand, offer) holding a live (active /
// paused) buyer row on role NULL: the target is created when missing (text = the offer's validated target, the
// newest nl_prompt under it, `pickValidatedTarget`; name = the offer's own, brand-service) and those rows become
// searches. No text / offer unknown to brand-service ⟹ skipped and reported, never guessed.
//
// Reversible: every write is in `offer_audience_realignments` under OFFER_AUDIENCE_ALIGN_REASON;
// `POST /internal/offer-audiences/realign/revert {reason}` undoes it (set OFFER_AUDIENCE_ALIGN_INTERVAL_MS=0 first,
// else the next tick aligns again). Timers only, never on the boot path; `=0` is the off switch.

import { and, eq } from "drizzle-orm";
import { db, sql as pg } from "../db/index.js";
import { audiences } from "../db/schema.js";
import { messageOf } from "../lib/db-error.js";
import { getMigrationState } from "../lib/migration-state.js";
import { readOfferName } from "../lib/offer-name.js";
import { pickValidatedTarget } from "./audience-refill.js";
import { alignOfferInTx, OFFER_AUDIENCE_ALIGN_REASON, type AlignOfferResult } from "./offer-audiences.js";

export interface AlignSweepResult {
  dryRun: boolean;
  offers: number;
  aligned: Array<{ orgId: string; brandId: string; offerId: string } & AlignOfferResult>;
  skipped: Array<{ orgId: string; brandId: string; offerId: string; reason: string }>;
}

export async function alignOfferAudiences(opts: { dryRun: boolean; brandId?: string }): Promise<AlignSweepResult> {
  const byBrand = opts.brandId ? pg`AND brand_id = ${opts.brandId}` : pg``;
  const pending = await pg<{ org_id: string; brand_id: string; offer_id: string }[]>`
    SELECT DISTINCT org_id, brand_id, offer_id FROM audiences
    WHERE role IS NULL AND relation IS NULL AND offer_id IS NOT NULL AND status IN ('active', 'paused') ${byBrand}
    ORDER BY org_id, brand_id, offer_id
  `;
  const result: AlignSweepResult = { dryRun: opts.dryRun, offers: pending.length, aligned: [], skipped: [] };
  for (const p of pending) {
    const scope = { orgId: p.org_id, brandId: p.brand_id, offerId: p.offer_id };
    try {
      const rows = await db
        .select()
        .from(audiences)
        .where(and(eq(audiences.orgId, scope.orgId), eq(audiences.brandId, scope.brandId), eq(audiences.offerId, scope.offerId)));
      const hasTarget = rows.some((r) => r.role === "target" && r.status !== "deprecated" && !r.relation);
      const text = hasTarget ? "" : pickValidatedTarget(rows.filter((r) => r.role !== "target" && !r.relation && inLiveOrChosen(r.status)));
      if (!hasTarget && !text) {
        result.skipped.push({ ...scope, reason: "no_text" });
        continue;
      }
      const offerName = hasTarget ? "" : await readOfferName(scope.orgId, scope.brandId, scope.offerId);
      if (!hasTarget && !offerName) {
        result.skipped.push({ ...scope, reason: "offer_not_found" });
        continue;
      }
      const aligned = await db.transaction((tx) =>
        alignOfferInTx(tx, { ...scope, offerName: offerName ?? "", text: text ?? "", reason: OFFER_AUDIENCE_ALIGN_REASON, dryRun: opts.dryRun })
      );
      result.aligned.push({ ...scope, ...aligned });
    } catch (err) {
      console.error(`[human-service] offer_audiences.align_failed org=${scope.orgId} brand=${scope.brandId} offer=${scope.offerId}`, err);
      result.skipped.push({ ...scope, reason: `failed: ${messageOf(err)}` });
    }
  }
  console.log(
    `[human-service] offer_audiences.align_sweep dryRun=${opts.dryRun} offers=${result.offers} aligned=${result.aligned.length} skipped=${result.skipped.length}`
  );
  return result;
}

function inLiveOrChosen(status: string): boolean {
  return status === "active" || status === "paused" || status === "archived";
}

const DEFAULT_INITIAL_DELAY_MS = 10 * 60_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;

function readMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[human-service] offer_audiences.align_bad_env ${name}=${raw} — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

let running = false;

export function startOfferAudienceAlignSweep(): () => void {
  const intervalMs = readMs("OFFER_AUDIENCE_ALIGN_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  if (intervalMs === 0) {
    console.log("[human-service] offer_audiences.align_disabled interval=0");
    return () => {};
  }
  const tick = () => {
    if (running || getMigrationState() !== "ready") return;
    running = true;
    void alignOfferAudiences({ dryRun: false })
      .catch((err) => console.error("[human-service] offer_audiences.align_sweep_failed", err))
      .finally(() => {
        running = false;
      });
  };
  const timers: NodeJS.Timeout[] = [];
  const first = setTimeout(() => {
    tick();
    const repeat = setInterval(tick, intervalMs);
    repeat.unref?.();
    timers.push(repeat);
  }, readMs("OFFER_AUDIENCE_ALIGN_INITIAL_DELAY_MS", DEFAULT_INITIAL_DELAY_MS));
  first.unref?.();
  timers.push(first);
  return () => timers.forEach((t) => clearTimeout(t));
}
