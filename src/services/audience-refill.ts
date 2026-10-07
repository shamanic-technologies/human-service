// Audience REFILL — a paying client never stops getting emails sent just
// because every one of its audiences has been fully contacted
// (shamanic-technologies/human-service#285).
//
// When a brand with live billing runs low on people left to contact across its
// ACTIVE audiences, new audiences INSIDE the target the client validated are
// created before the pool hits zero. Owner rule (Kevin, 2026-10-04): finding
// more people the validated target describes is our job; contacting a
// population the client never agreed to is the CLIENT's decision. So when
// nobody new is left inside that target, the refill creates NO active audience:
// it stores a WIDENING PROPOSAL (audience_widening_proposals: the wider target
// and the segments it would add) for the client to accept or decline
// (src/services/audience-widening.ts). Nothing in a proposal is contacted, and
// no screen target is rewritten until the client accepts. Before this, the
// refill widened on its own (Shockwavecenters 2026-10-04: chiropractic clinic
// owners got Athletic Trainers, Massage Therapists, Clinic Managers, served).
// Nothing new is invented to do it:
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
//     ensureApolloPointer), with the validated target and the audiences already
//     held given to the split, so the segments it proposes reach people of that
//     target outside them. Rows are born `active` under the brand's offer with
//     the validated target as `nl_prompt` (unchanged), tagged
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

import { and, desc, eq, ne, notInArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  audiences,
  audienceWideningProposals,
  leadServes,
  type WideningSegment,
} from "../db/schema.js";
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
import { sourcingOriginSlug } from "./sourcing-origin.js";
import { ensureTargetText } from "./audience-target-text.js";

type AudienceRow = typeof audiences.$inferSelect;

/** Days of the brand's own pace the remaining pool must cover. */
export const RUNWAY_DAYS = 7;
/** Trailing window the daily pace is measured over. */
export const PACE_WINDOW_DAYS = 14;
/** At most one refill per brand in this many days. */
export const REFILL_COOLDOWN_DAYS = 3;
export const AUTO_REFILL_SOURCE = "auto_refill";
/** Provenance of the audiences an ACCEPTED widening proposal creates: the
 * client agreed to their target, so it is a validated one. */
export const WIDENING_ACCEPTED_SOURCE = "widening_accepted";

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
    // until serve-next walks it, never "empty". It is left OUT of the measure
    // (counts for nothing), never a reason to skip the brand: every brand now
    // gets one at launch (competitor-engagement-audience.ts), so skipping would
    // switch the refill off fleet-wide. Only a brand with nothing else active is
    // unmeasurable.
    const measured = active.filter(
      (a) => !(isLinkedinEngagementFilters(a.filters) && a.reachableCount == null)
    );
    if (measured.length === 0) {
      pools.push({ ...base, remaining: 0, low: false, unmeasurable: "linkedin_engagement_unsized" });
      continue;
    }
    // An audience whose Apollo build has not landed has no count yet (it reads
    // 0); that is "not measured yet", never "empty".
    if (measured.some((a) => needsApolloPointerBuild(a))) {
      pools.push({ ...base, remaining: 0, low: false, unmeasurable: "pointer_build_pending" });
      continue;
    }
    const contactability = await computeAudienceContactability(measured);
    const remaining = measured.reduce(
      (sum, a) => sum + (contactability.get(a.id)?.availableToContactCount ?? 0),
      0
    );
    pools.push({ ...base, remaining, low: isPoolLow({ remaining, dailyPace }), unmeasurable: null });
  }
  return pools;
}

function describeSells(offer: { name: string; description?: string | null } | null): string {
  return offer ? `${offer.name}${offer.description ? `: ${offer.description}` : ""}` : "(not stated)";
}

/**
 * The FIRST split request of a refill: more people INSIDE the target the client
 * validated, outside every audience the brand already holds. ZERO segments is a
 * correct answer (measured 2026-10-02: ObraCam's audiences already covered every
 * company size of its target, and the split said so), and it is what sends the
 * refill to a widening PROPOSAL instead of new active audiences.
 */
export function buildInTargetRefillRequest(args: {
  target: string;
  offer: { name: string; description?: string | null } | null;
  existing: Array<{ name: string; description: string | null }>;
}): string {
  return [
    `WHAT THIS COMPANY SELLS: ${describeSells(args.offer)}`,
    `THE TARGET THE CLIENT VALIDATED: ${args.target}`,
    "",
    "The audiences listed below already exist for this target. Split ONLY people this",
    "target describes who are NOT in any audience below: the places, company sizes,",
    "industries or roles the target names or allows that these audiences did not cover.",
    "Every segment stays inside the target as written: never add a role, a kind of",
    "company or a place the target does not describe. Never repeat or overlap an audience",
    "below. If the audiences below already cover the whole target, return ZERO segments",
    "(an empty segments array): that answer is correct.",
    "",
    "Audiences already held:",
    ...args.existing.map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ""}`),
  ].join("\n");
}

/**
 * The SECOND split request, only once nobody is left inside the validated
 * target: the NEXT closest buyers of what the company sells (other roles in the
 * same kind of companies, or adjacent kinds of companies, same places). Its
 * answer is never created as active audiences: it becomes a widening PROPOSAL
 * the client accepts or declines.
 */
export function buildWideningRequest(args: {
  target: string;
  offer: { name: string; description?: string | null } | null;
  existing: Array<{ name: string; description: string | null }>;
}): string {
  return [
    `WHAT THIS COMPANY SELLS: ${describeSells(args.offer)}`,
    `ITS TARGET SO FAR: ${args.target}`,
    "",
    "Every reachable person in the audiences listed below has already been contacted, and",
    "the target so far has no one left. Your target for this split is the NEXT closest",
    "people who would also buy or use what this company sells and who are NOT in any",
    "audience below: other roles in the same kind of companies (people who decide on, buy",
    "or use what is sold), or adjacent kinds of companies, in the same places as the target",
    "so far. Never repeat or overlap an audience below. If nobody close is left, return",
    "ZERO segments.",
    "",
    "Audiences already contacted:",
    ...args.existing.map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ""}`),
  ].join("\n");
}

/**
 * The target the client VALIDATED for an offer: the newest audience the client
 * (or an accepted widening) created, active first. Rows the refill created are
 * never a source: before 2026-10-04 they carried a target the refill widened on
 * its own, which the client never agreed to.
 */
export function pickValidatedTarget(
  rows: Array<Pick<AudienceRow, "nlPrompt" | "source" | "status" | "createdAt">>
): string | null {
  const candidates = rows
    .filter((r) => r.source !== AUTO_REFILL_SOURCE && r.status !== "deprecated" && r.nlPrompt?.trim())
    .sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        b.createdAt.getTime() - a.createdAt.getTime()
    );
  return candidates[0]?.nlPrompt?.trim() ?? null;
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
  /** Nobody new inside the target, and the client already DECLINED widening
   * this same target: their decision stands, nothing is re-proposed. */
  | "widening_declined"
  /** Nobody new inside the target and nobody close outside it either. */
  | "nothing_left"
  | "failed";

type WideningRow = typeof audienceWideningProposals.$inferSelect;

/** A widening proposal as every consumer reads it (refill answer, GET, accept,
 * decline). */
export interface WideningProposalView {
  id: string;
  orgId: string;
  brandId: string;
  offerId: string;
  status: "pending" | "accepted" | "declined";
  baseTarget: string;
  widenedTarget: string;
  segments: WideningSegment[];
  createdAt: string;
  decidedAt: string | null;
  createdAudienceIds: string[];
}

export function toWideningProposalView(row: WideningRow): WideningProposalView {
  return {
    id: row.id,
    orgId: row.orgId,
    brandId: row.brandId,
    offerId: row.offerId,
    status: row.status as WideningProposalView["status"],
    baseTarget: row.baseTarget,
    widenedTarget: row.widenedTarget,
    segments: row.segments,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAudienceIds: row.createdAudienceIds ?? [],
  };
}

export interface RefillOutcome {
  orgId: string;
  brandId: string;
  remaining: number;
  dailyPace: number;
  billingState: PaymentOutlook["state"] | "no_account" | null;
  /**
   * - `refilled`: new ACTIVE audiences INSIDE the validated target (`created`).
   * - `widening_proposed`: nobody new inside the target; a widening proposal is
   *   waiting for the client (`proposal`, status pending). Nothing created.
   * - `would_refill`: dry run, the brand passes every guard.
   * - `skipped`: nothing could be done, `reason` / `detail` say why.
   */
  action: "refilled" | "widening_proposed" | "would_refill" | "skipped";
  reason: RefillSkipReason | null;
  detail: string | null;
  created: Array<{ id: string; name: string; description: string | null }>;
  proposal: WideningProposalView | null;
}

export interface RefillResult {
  dryRun: boolean;
  scanned: number;
  low: number;
  refilled: number;
  /** Brands whose answer is a pending widening proposal. */
  proposed: number;
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
    proposal: null,
  };
  const skip = (reason: RefillSkipReason, detail: string | null = null) => {
    out.reason = reason;
    out.detail = detail;
    return out;
  };

  if (pool.unmeasurable) return skip("unmeasurable", pool.unmeasurable);
  if (!pool.low) return skip("not_low");

  // A widening proposal already waits for the client: that IS the answer
  // (nothing left inside the target, the decision is theirs). Free, no spend,
  // dry run included.
  const [pending] = await db
    .select()
    .from(audienceWideningProposals)
    .where(
      and(
        eq(audienceWideningProposals.orgId, pool.orgId),
        eq(audienceWideningProposals.brandId, pool.brandId),
        eq(audienceWideningProposals.status, "pending")
      )
    )
    .orderBy(desc(audienceWideningProposals.createdAt))
    .limit(1);
  if (pending) {
    out.action = "widening_proposed";
    out.proposal = toWideningProposalView(pending);
    out.detail = `pending_since=${pending.createdAt.toISOString()}`;
    return out;
  }

  const [recent] = await db
    .select({ id: audiences.id })
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, pool.orgId),
        eq(audiences.brandId, pool.brandId),
        eq(audiences.source, AUTO_REFILL_SOURCE),
        // A refill the client / staff REJECTED (its audiences archived or
        // deprecated) used no slot: counting it would block the very refill
        // that replaces it (Shockwavecenters 2026-10-05: the 4 out-of-target
        // audiences of the old logic were archived, the brand had 0 left and
        // still answered cooldown). Paused rows still count (not a rejection).
        notInArray(audiences.status, ["archived", "deprecated"]),
        sql`${audiences.createdAt} > now() - make_interval(days => ${REFILL_COOLDOWN_DAYS})`
      )
    )
    .limit(1);
  if (recent) return skip("cooldown");
  // A proposal produced (and since decided) inside the window counts too: the
  // splits that produced it were billed.
  const [recentProposal] = await db
    .select({ id: audienceWideningProposals.id })
    .from(audienceWideningProposals)
    .where(
      and(
        eq(audienceWideningProposals.orgId, pool.orgId),
        eq(audienceWideningProposals.brandId, pool.brandId),
        sql`${audienceWideningProposals.createdAt} > now() - make_interval(days => ${REFILL_COOLDOWN_DAYS})`
      )
    )
    .limit(1);
  if (recentProposal) return skip("cooldown", "widening_proposal");

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
  // The validated target, never one the refill wrote: active rows first, then
  // the brand's paused / archived ones under the same offer.
  let target = pickValidatedTarget(inOffer);
  if (!target) {
    const held = await db
      .select()
      .from(audiences)
      .where(
        and(
          eq(audiences.orgId, pool.orgId),
          eq(audiences.brandId, pool.brandId),
          eq(audiences.offerId, offerId),
          ne(audiences.status, "deprecated")
        )
      );
    target = pickValidatedTarget(held);
  }
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

  // A refill builds new Apollo search lists: its run and every call under it
  // carry that sourcing origin (unresolvable ⟹ skipped loud, nothing spent).
  let featureSlug: string;
  try {
    featureSlug = await sourcingOriginSlug("apollo_search");
  } catch (err) {
    return skip("failed", `sourcing origin unresolved: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tracking = { brandIds: [pool.brandId], featureSlug };
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
    const inside = await proposeAudienceSplit(
      buildInTargetRefillRequest({ target, offer, existing }),
      identity,
      { allowEmpty: true }
    );
    if (inside.segments.length === 0) {
      const answer = await proposeWidening({ pool, offerId, offer, target, existing, userId, identity, taken: taken.map((t) => t.name) });
      await completeRun(runId, "completed", runIdentity);
      if (answer.kind === "skip") return skip(answer.reason, answer.detail);
      out.action = "widening_proposed";
      out.proposal = answer.proposal;
      return out;
    }
    const names = dedupeSegmentNames(
      inside.segments.map((s) => s.name),
      taken.map((t) => t.name)
    );
    // Inside the validated target: the screen target is that target, verbatim.
    created = await confirmAudienceSplit({
      orgId: pool.orgId,
      userId,
      brandId: pool.brandId,
      offerId,
      targetAudience: target,
      segments: inside.segments.map((s, i) => ({ name: names[i], description: s.description })),
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
    void ensureTargetText(row, { orgId: pool.orgId, userId }).catch((err) =>
      console.error(
        `[human-service] audience_refill.target_text.failed org=${pool.orgId} audience=${row.id}`,
        err
      )
    );
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

/**
 * Nobody new is left inside the validated target. Ask for the next closest
 * buyers and STORE them as a pending proposal (never as audiences). A target the
 * client already declined to widen is not re-proposed.
 */
async function proposeWidening(args: {
  pool: BrandPool;
  offerId: string;
  offer: { name: string; description?: string | null } | null;
  target: string;
  existing: Array<{ name: string; description: string | null }>;
  userId: string;
  identity: { orgId: string; userId: string; runId: string; workflowTracking: { brandIds: string[] } };
  taken: string[];
}): Promise<
  | { kind: "proposed"; proposal: WideningProposalView }
  | { kind: "skip"; reason: RefillSkipReason; detail: string | null }
> {
  const { pool, offerId, target } = args;
  const [declined] = await db
    .select({ id: audienceWideningProposals.id })
    .from(audienceWideningProposals)
    .where(
      and(
        eq(audienceWideningProposals.orgId, pool.orgId),
        eq(audienceWideningProposals.brandId, pool.brandId),
        eq(audienceWideningProposals.offerId, offerId),
        eq(audienceWideningProposals.status, "declined"),
        eq(audienceWideningProposals.baseTarget, target)
      )
    )
    .limit(1);
  if (declined) return { kind: "skip", reason: "widening_declined", detail: `proposal=${declined.id}` };

  const wide = await proposeAudienceSplit(
    buildWideningRequest({ target, offer: args.offer, existing: args.existing }),
    args.identity,
    { allowEmpty: true }
  );
  if (wide.segments.length === 0) {
    return { kind: "skip", reason: "nothing_left", detail: "no one new inside the target, no one close outside it" };
  }
  // The screen target the accepted audiences would carry: the old one plus the
  // new segments, restated person-level from what the offer sells. No offer
  // readable ⟹ the literal old target + segments (never a guess, never the old
  // target alone, which would reject every widened person).
  const widenedTarget =
    (await draftAudienceTarget({
      customerTarget: buildWidenedTarget(target, wide.segments),
      brandId: pool.brandId,
      offerId,
      identity: args.identity,
    })) ?? buildWidenedTarget(target, wide.segments);
  const names = dedupeSegmentNames(
    wide.segments.map((s) => s.name),
    args.taken
  );
  const [row] = await db
    .insert(audienceWideningProposals)
    .values({
      orgId: pool.orgId,
      brandId: pool.brandId,
      offerId,
      baseTarget: target,
      widenedTarget,
      segments: wide.segments.map((s, i) => ({
        name: names[i],
        description: s.description,
        icon: s.icon ?? null,
        estimatedLeadCount: s.estimatedLeadCount,
      })),
      status: "pending",
      createdByUserId: args.userId,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { kind: "proposed", proposal: toWideningProposalView(row) };
  // A concurrent run stored one first (one pending per scope): that one stands.
  const [existingPending] = await db
    .select()
    .from(audienceWideningProposals)
    .where(
      and(
        eq(audienceWideningProposals.orgId, pool.orgId),
        eq(audienceWideningProposals.brandId, pool.brandId),
        eq(audienceWideningProposals.offerId, offerId),
        eq(audienceWideningProposals.status, "pending")
      )
    )
    .limit(1);
  if (!existingPending) {
    return { kind: "skip", reason: "failed", detail: "widening proposal insert conflicted with no pending row" };
  }
  return { kind: "proposed", proposal: toWideningProposalView(existingPending) };
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
          `[human-service] audience_refill.brand org=${outcome.orgId} brand=${outcome.brandId} remaining=${outcome.remaining} pace=${outcome.dailyPace} billing=${outcome.billingState ?? "n/a"} action=${outcome.action} reason=${outcome.reason ?? "-"} created=${outcome.created.length}${outcome.proposal ? ` proposal=${outcome.proposal.id}` : ""}${outcome.detail ? ` detail=${JSON.stringify(outcome.detail)}` : ""}`
        );
      }
    }
    const result: RefillResult = {
      dryRun,
      scanned: pools.length,
      low: pools.filter((p) => p.low).length,
      refilled: outcomes.filter((o) => o.action === "refilled").length,
      proposed: outcomes.filter((o) => o.action === "widening_proposed").length,
      outcomes,
    };
    console.log(
      `[human-service] audience_refill.${dryRun ? "dry_run" : "run"} scanned=${result.scanned} low=${result.low} refilled=${result.refilled} proposed=${result.proposed}`
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
