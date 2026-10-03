// Audience REFILL — a paying client never stops getting emails sent just
// because every one of its audiences has been fully contacted
// (shamanic-technologies/human-service#285).
//
// When a brand with live billing runs low on people left to contact across its
// ACTIVE audiences, new audiences matching its existing target are created
// before the pool hits zero. Nothing new is invented to do it:
//
//   - LOW POOL is measured with the numbers the dashboard already shows:
//     `availableToContactCount` (computeAudienceContactability, the list's
//     "Remaining") summed over the brand's active audiences, against the brand's
//     own daily serve pace (lead_serves over the trailing window, per day it was
//     actually served). Low ⟺ fewer people left than RUNWAY_DAYS of that pace.
//   - CAN PAY is billing-service's own verdict (src/lib/billing-outlook.ts):
//     only `will_charge` / `charge_due_now`. Owner rule: never spend for a client
//     who cannot be charged. An unreadable outlook never counts as chargeable.
//   - NEW PEOPLE = NEW AUDIENCES, never an edited one. An audience is immutable
//     (its stats key on its id), so the refill runs the same split → confirm →
//     Apollo pointer build path a human uses (audience-split.ts +
//     ensureApolloPointer), with the brand's existing target and the audiences
//     already contacted given to the split, so the segments it proposes reach
//     people outside them. Rows are born `active` under the brand's offer, tagged
//     `source='auto_refill'`.
//   - SPEND is org-billed and declared where it is incurred: the split's two LLM
//     calls in chat-service (under an `audience-refill` run this job opens for
//     the org), the Apollo build in apollo-service (each under its own
//     `audience-pointer-build` run). human-service declares no cost.
//   - CAMPAIGNS ARE NEVER TOUCHED. Restarting is the client's call; this only
//     makes sure people are there when they do.
//
// Guard rails: one refill per brand per REFILL_COOLDOWN_DAYS (so a market that
// is genuinely dry is not re-billed every tick); a brand whose pool cannot be
// measured (an active audience still waiting for its Apollo build, or a CRM
// audience with no provider count) is skipped, never guessed.
//
// Boot safety: NOTHING here is awaited before `app.listen()` (same pattern as
// offer-attribution-sweep.ts).

import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences, leadServes } from "../db/schema.js";
import { getMigrationState } from "../lib/migration-state.js";
import {
  canBeCharged,
  getPaymentOutlook,
  type PaymentOutlook,
} from "../lib/billing-outlook.js";
import { computeAudienceContactability, ensureApolloPointer, needsApolloPointerBuild } from "./audiences.js";
import { isLinkedinEngagementFilters } from "../lib/apollo-audiences.js";
import { confirmAudienceSplit, proposeAudienceSplit } from "./audience-split.js";
import { draftAudienceTarget } from "./audience-target.js";
import { listBrandOffers } from "../lib/brand-offers.js";
import { completeRun, createRun } from "./runs.js";

type AudienceRow = typeof audiences.$inferSelect;

/** Days of the brand's own pace the remaining pool must cover. */
export const RUNWAY_DAYS = 7;
/** Trailing window the daily pace is measured over. */
export const PACE_WINDOW_DAYS = 14;
/** At most one refill per brand in this many days. */
export const REFILL_COOLDOWN_DAYS = 3;
export const AUTO_REFILL_SOURCE = "auto_refill";

const DEFAULT_INITIAL_DELAY_MS = 10 * 60_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * The low-pool rule. A brand that has not been served in the window has no
 * pace and is never "low" (nothing is running out). Otherwise low ⟺ fewer
 * people left than `runwayDays` of its own daily pace.
 */
export function isPoolLow(args: {
  remaining: number;
  dailyPace: number;
  runwayDays?: number;
}): boolean {
  const runway = args.runwayDays ?? RUNWAY_DAYS;
  if (!(args.dailyPace > 0)) return false;
  return args.remaining < args.dailyPace * runway;
}

export interface BrandPool {
  orgId: string;
  brandId: string;
  activeAudiences: number;
  remaining: number;
  /** Serves per day the brand was served, over the trailing window. */
  dailyPace: number;
  low: boolean;
  /** Why the pool could not be measured. Null when it was. */
  unmeasurable: "pointer_build_pending" | "crm_audience" | "linkedin_engagement_unsized" | "no_active_audience" | null;
}

/**
 * Measure every brand served in the trailing window. Pace counts serves that
 * reached the campaign (verdict `valid`, or NULL = served before the gate),
 * divided by the number of distinct days the brand was served, so a client who
 * stopped their campaigns keeps the pace they ran at.
 */
export async function loadBrandPools(opts: { brandId?: string } = {}): Promise<BrandPool[]> {
  const paceRows = await db
    .select({
      orgId: leadServes.orgId,
      brandId: leadServes.brandId,
      serves: sql<number>`count(*)::int`,
      days: sql<number>`count(distinct date_trunc('day', ${leadServes.servedAt}))::int`,
    })
    .from(leadServes)
    .where(
      and(
        sql`${leadServes.servedAt} > now() - make_interval(days => ${PACE_WINDOW_DAYS})`,
        sql`(${leadServes.emailVerdict} is null or ${leadServes.emailVerdict} = 'valid')`,
        ...(opts.brandId ? [eq(leadServes.brandId, opts.brandId)] : [])
      )
    )
    .groupBy(leadServes.orgId, leadServes.brandId);

  const pools: BrandPool[] = [];
  for (const p of paceRows) {
    const dailyPace = p.days > 0 ? p.serves / p.days : 0;
    const active = await db
      .select()
      .from(audiences)
      .where(
        and(
          eq(audiences.orgId, p.orgId),
          eq(audiences.brandId, p.brandId),
          eq(audiences.status, "active")
        )
      );
    const base = { orgId: p.orgId, brandId: p.brandId, activeAudiences: active.length, dailyPace };
    // Every active audience was paused/archived by the client: their choice.
    if (active.length === 0) {
      pools.push({ ...base, remaining: 0, low: false, unmeasurable: "no_active_audience" });
      continue;
    }
    // A CRM audience has no provider count, so its Remaining reads 0 whatever
    // the file holds: the pool is unknown, never "empty".
    if (active.some((a) => a.provider === "crm" || a.crmUploadId)) {
      pools.push({ ...base, remaining: 0, low: false, unmeasurable: "crm_audience" });
      continue;
    }
    // A linkedin_engagement audience has no provider count: its pool is unknown
    // until serve-next walks it, never "empty".
    if (active.some((a) => isLinkedinEngagementFilters(a.filters) && a.reachableCount == null)) {
      pools.push({ ...base, remaining: 0, low: false, unmeasurable: "linkedin_engagement_unsized" });
      continue;
    }
    // An audience whose Apollo build has not landed has no count yet (it reads
    // 0); that is "not measured yet", never "empty".
    if (active.some((a) => needsApolloPointerBuild(a))) {
      pools.push({ ...base, remaining: 0, low: false, unmeasurable: "pointer_build_pending" });
      continue;
    }
    const contactability = await computeAudienceContactability(active);
    const remaining = active.reduce(
      (sum, a) => sum + (contactability.get(a.id)?.availableToContactCount ?? 0),
      0
    );
    pools.push({ ...base, remaining, low: isPoolLow({ remaining, dailyPace }), unmeasurable: null });
  }
  return pools;
}

/**
 * The split request for a refill. The target as written is exhausted (that is
 * why we are here: measured 2026-10-02, ObraCam's split answered ZERO segments
 * when asked for "the same target, minus these audiences", correctly, since its
 * audiences already covered every company size of it). So the split is asked
 * for the NEXT closest buyers of what the company sells: other roles in the same
 * kind of companies, or adjacent kinds of companies, in the same places, outside
 * every audience it already holds. The split prompt's form rules (filterable
 * axes, positive values, one population per segment) still apply.
 */
export function buildRefillRequest(args: {
  target: string;
  offer: { name: string; description?: string | null } | null;
  existing: Array<{ name: string; description: string | null }>;
}): string {
  const sells = args.offer
    ? `${args.offer.name}${args.offer.description ? `: ${args.offer.description}` : ""}`
    : "(not stated)";
  return [
    `WHAT THIS COMPANY SELLS: ${sells}`,
    `ITS TARGET SO FAR: ${args.target}`,
    "",
    "Every reachable person in the audiences listed below has already been contacted, and",
    "the target so far has no one left. Your target for this split is the NEXT closest",
    "people who would also buy or use what this company sells and who are NOT in any",
    "audience below: other roles in the same kind of companies (people who decide on, buy",
    "or use what is sold), or adjacent kinds of companies, in the same places as the target",
    "so far. Never repeat or overlap an audience below. Return at least one segment.",
    "",
    "Audiences already contacted:",
    ...args.existing.map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ""}`),
  ].join("\n");
}

/** The customer target the widened audiences are screened against: the old
 * target plus every new segment, restated person-level by draftAudienceTarget. */
export function buildWidenedTarget(target: string, segments: Array<{ description: string }>): string {
  return [target, "Also:", ...segments.map((s) => `- ${s.description}`)].join("\n");
}

/** Make each new name unique within the (org, brand, offer) scope. */
export function dedupeSegmentNames(
  names: string[],
  taken: Iterable<string>,
  now: Date = new Date()
): string[] {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const stamp = now.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return names.map((name) => {
    let candidate = name;
    if (used.has(candidate.toLowerCase())) candidate = `${name} ${stamp}`;
    let i = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${name} ${stamp} ${i++}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/** The offer most of the brand's active audiences belong to (ties: most recent). */
export function pickOffer(active: AudienceRow[]): string | null {
  const counts = new Map<string, { n: number; latest: number }>();
  for (const a of active) {
    if (!a.offerId) continue;
    const c = counts.get(a.offerId) ?? { n: 0, latest: 0 };
    c.n += 1;
    c.latest = Math.max(c.latest, a.createdAt.getTime());
    counts.set(a.offerId, c);
  }
  let best: string | null = null;
  let bestC = { n: 0, latest: 0 };
  for (const [offerId, c] of counts) {
    if (c.n > bestC.n || (c.n === bestC.n && c.latest > bestC.latest)) {
      best = offerId;
      bestC = c;
    }
  }
  return best;
}

export type RefillSkipReason =
  | "not_low"
  | "unmeasurable"
  | "cooldown"
  | "not_chargeable"
  | "billing_unreadable"
  | "no_offer"
  | "no_target"
  | "no_user"
  | "failed";

export interface RefillOutcome {
  orgId: string;
  brandId: string;
  remaining: number;
  dailyPace: number;
  billingState: PaymentOutlook["state"] | "no_account" | null;
  action: "refilled" | "would_refill" | "skipped";
  reason: RefillSkipReason | null;
  detail: string | null;
  created: Array<{ id: string; name: string; description: string | null }>;
}

export interface RefillResult {
  dryRun: boolean;
  scanned: number;
  low: number;
  refilled: number;
  outcomes: RefillOutcome[];
}

async function refillBrand(
  pool: BrandPool,
  dryRun: boolean
): Promise<RefillOutcome> {
  const out: RefillOutcome = {
    orgId: pool.orgId,
    brandId: pool.brandId,
    remaining: pool.remaining,
    dailyPace: Math.round(pool.dailyPace * 10) / 10,
    billingState: null,
    action: "skipped",
    reason: null,
    detail: null,
    created: [],
  };
  const skip = (reason: RefillSkipReason, detail: string | null = null) => {
    out.reason = reason;
    out.detail = detail;
    return out;
  };

  if (pool.unmeasurable) return skip("unmeasurable", pool.unmeasurable);
  if (!pool.low) return skip("not_low");

  const [recent] = await db
    .select({ id: audiences.id })
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, pool.orgId),
        eq(audiences.brandId, pool.brandId),
        eq(audiences.source, AUTO_REFILL_SOURCE),
        sql`${audiences.createdAt} > now() - make_interval(days => ${REFILL_COOLDOWN_DAYS})`
      )
    )
    .limit(1);
  if (recent) return skip("cooldown");

  // The billing gate comes BEFORE anything that spends.
  let outlook: PaymentOutlook | null;
  try {
    outlook = await getPaymentOutlook(pool.orgId);
  } catch (err) {
    return skip("billing_unreadable", err instanceof Error ? err.message : String(err));
  }
  out.billingState = outlook ? outlook.state : "no_account";
  if (!canBeCharged(outlook)) return skip("not_chargeable", out.billingState);

  const active = await db
    .select()
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, pool.orgId),
        eq(audiences.brandId, pool.brandId),
        eq(audiences.status, "active")
      )
    )
    .orderBy(desc(audiences.createdAt));
  const offerId = pickOffer(active);
  if (!offerId) return skip("no_offer");
  const inOffer = active.filter((a) => a.offerId === offerId);
  const target = inOffer.find((a) => a.nlPrompt?.trim())?.nlPrompt?.trim() ?? null;
  if (!target) return skip("no_target");
  const userId = inOffer.find((a) => a.createdByUserId)?.createdByUserId ?? null;
  if (!userId) return skip("no_user");

  if (dryRun) {
    out.action = "would_refill";
    out.detail = `offer=${offerId}`;
    return out;
  }

  // Everything the brand already holds under the offer (archived included), so
  // the split steers away from all of it.
  const existing = await db
    .select({ name: audiences.name, description: audiences.description })
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, pool.orgId),
        eq(audiences.brandId, pool.brandId),
        eq(audiences.offerId, offerId),
        ne(audiences.status, "deprecated")
      )
    )
    .orderBy(desc(audiences.createdAt))
    .limit(40);

  const tracking = { brandIds: [pool.brandId] };
  const runId = await createRun({
    orgId: pool.orgId,
    userId,
    taskName: "audience-refill",
    workflowTracking: tracking,
  });
  if (!runId) return skip("failed", "runs-service did not open a run for the refill");
  const runIdentity = { orgId: pool.orgId, userId, workflowTracking: tracking };

  let created: AudienceRow[];
  try {
    const identity = { orgId: pool.orgId, userId, runId, workflowTracking: tracking };
    const offer = (await listBrandOffers(pool.brandId, pool.orgId)).find((o) => o.offerId === offerId) ?? null;
    const proposal = await proposeAudienceSplit(
      buildRefillRequest({ target, offer, existing }),
      identity
    );
    // The widened audiences reach people the old target did not name, so the
    // pre-pay screen must judge them against a target that does: the old one
    // plus the new segments, restated person-level from what the offer sells.
    // No offer readable ⟹ the old target verbatim (never a guess).
    const widened =
      (await draftAudienceTarget({
        customerTarget: buildWidenedTarget(target, proposal.segments),
        brandId: pool.brandId,
        offerId,
        identity,
      })) ?? target;
    // Every name in the (org, brand, offer) scope, deprecated included: the
    // unique index covers them all, so a collision would 409 the confirm.
    const taken = await db
      .select({ name: audiences.name })
      .from(audiences)
      .where(
        and(
          eq(audiences.orgId, pool.orgId),
          eq(audiences.brandId, pool.brandId),
          eq(audiences.offerId, offerId)
        )
      );
    const names = dedupeSegmentNames(
      proposal.segments.map((s) => s.name),
      taken.map((t) => t.name)
    );
    created = await confirmAudienceSplit({
      orgId: pool.orgId,
      userId,
      brandId: pool.brandId,
      offerId,
      targetAudience: widened,
      segments: proposal.segments.map((s, i) => ({ name: names[i], description: s.description })),
      source: AUTO_REFILL_SOURCE,
    });
    await completeRun(runId, "completed", runIdentity);
  } catch (err) {
    await completeRun(runId, "failed", runIdentity);
    return skip("failed", err instanceof Error ? err.message : String(err));
  }

  // Build each new audience's Apollo filters in the background, org-billed,
  // each under its own run (same as a human split confirm). serve-next builds
  // inline if one has not landed, so a refilled audience is never unservable.
  for (const row of created) {
    void ensureApolloPointer(row, { orgId: pool.orgId, userId }).catch((err) =>
      console.error(
        `[human-service] audience_refill.pointer_build.failed org=${pool.orgId} audience=${row.id}`,
        err
      )
    );
  }

  out.action = "refilled";
  out.created = created.map((r) => ({ id: r.id, name: r.name, description: r.description }));
  return out;
}

let running = false;

/**
 * One sweep. `dryRun` measures, reads billing (free) and reports who would be
 * refilled, writing and spending nothing. Returns null when skipped (schema not
 * ready or a previous run still in flight).
 */
export async function runAudienceRefillSweep(
  opts: { dryRun?: boolean; brandId?: string } = {}
): Promise<RefillResult | null> {
  const dryRun = opts.dryRun ?? false;
  if (running) {
    console.log("[human-service] audience_refill.skip reason=already_running");
    return null;
  }
  const migrations = getMigrationState();
  if (migrations !== "ready") {
    console.log(`[human-service] audience_refill.skip reason=migrations_${migrations}`);
    return null;
  }
  running = true;
  try {
    const pools = await loadBrandPools({ brandId: opts.brandId });
    const outcomes: RefillOutcome[] = [];
    for (const pool of pools) {
      const outcome = await refillBrand(pool, dryRun);
      outcomes.push(outcome);
      if (outcome.reason !== "not_low") {
        console.log(
          `[human-service] audience_refill.brand org=${outcome.orgId} brand=${outcome.brandId} remaining=${outcome.remaining} pace=${outcome.dailyPace} billing=${outcome.billingState ?? "n/a"} action=${outcome.action} reason=${outcome.reason ?? "-"} created=${outcome.created.length}${outcome.detail ? ` detail=${JSON.stringify(outcome.detail)}` : ""}`
        );
      }
    }
    const result: RefillResult = {
      dryRun,
      scanned: pools.length,
      low: pools.filter((p) => p.low).length,
      refilled: outcomes.filter((o) => o.action === "refilled").length,
      outcomes,
    };
    console.log(
      `[human-service] audience_refill.${dryRun ? "dry_run" : "run"} scanned=${result.scanned} low=${result.low} refilled=${result.refilled}`
    );
    return result;
  } finally {
    running = false;
  }
}

function readMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[human-service] audience_refill.bad_env ${name}=${raw} — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Arm the recurring sweep. Only schedules timers (first tick delayed, every
 * tick fire-and-forget), so it is safe right after `app.listen()`.
 * `AUDIENCE_REFILL_INTERVAL_MS=0` disables it (emergency off switch).
 */
export function startAudienceRefillSweep(): () => void {
  const intervalMs = readMs("AUDIENCE_REFILL_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  if (intervalMs === 0) {
    console.log("[human-service] audience_refill.disabled interval=0");
    return () => {};
  }
  const initialDelayMs = readMs("AUDIENCE_REFILL_INITIAL_DELAY_MS", DEFAULT_INITIAL_DELAY_MS);
  console.log(
    `[human-service] audience_refill.armed initialDelayMs=${initialDelayMs} intervalMs=${intervalMs}`
  );
  const tick = () => {
    void runAudienceRefillSweep().catch((err) =>
      console.error("[human-service] audience_refill.failed", err)
    );
  };
  let repeat: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    tick();
    repeat = setInterval(tick, intervalMs);
    repeat.unref?.();
  }, initialDelayMs);
  first.unref?.();
  return () => {
    clearTimeout(first);
    if (repeat) clearInterval(repeat);
  };
}
