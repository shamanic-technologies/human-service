// LEAD SOURCING (owner 2026-10-11): the sourcing channel that PICKS its own sources.
//
// A sales funnel is a straight line, ONE channel per leg. On Start -> Lead found that channel is one origin
// (Apollo Cold Filters, Apollo Buying Signals, LinkedIn Engagement Signals, Your CRM Contacts) or LEAD
// SOURCING, where THIS service decides which origins the brand uses:
//
//   - IN LINE WITH THE BRAND: the origins it may choose among (the UNIVERSE) are the ones the brand already had
//     ON when it moved to Lead Sourcing (owner's migration: nothing changes for the client), else every origin
//     Lead Sourcing may use (features-service `leadSourcing.mayUseByChannel`). Each origin's lists are built per
//     client profile and screened against the profile (src/services/profile-sources.ts), and lead-service
//     qualifies every lead on the offer's ICP checks before paying: an origin that fits nothing of the brand
//     has no list, so it never serves.
//   - BY ROI: within the universe, features-service's measured money per origin (`/offers/:id/sourcing`: leads
//     served, positive replies, end-to-end cost). An origin is DROPPED once it spent at least
//     NO_RETURN_SPEND_MULTIPLE x the best origin's cost per positive reply with no positive reply at all (three
//     replies' worth at the best rate and none: the chance of that by luck is ~5%). Never below one origin. Which
//     KEPT origin serves each run stays campaign-service's picker (cost per outcome per audience, owner
//     2026-10-11 "let the picker decide"), so a weaker origin keeps a small, measured share.
//
// Applying it: the source-campaign reconcile (src/services/source-campaigns.ts) turns an origin's lists ON while
// Lead Sourcing is ON and the origin is chosen, exactly like that origin's own source campaign would. lead-service
// files a serve under Lead Sourcing only for a chosen origin (GET /orgs/lead-sourcing/sources).
//
// Spend: none. Reading the decision and its evidence is free; a list it turns ON is built by the existing source
// campaign code, org-billed as always.

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { leadSourcingChoiceChanges, leadSourcingChoices, sourceCampaignStates, type LeadSourcingChoice } from "../db/schema.js";
import { fetchLeadSourcingOrigins } from "../lib/features-sourcing.js";
import { fetchOfferSourcingEvidence, type OriginEvidence } from "../lib/features-offer-sourcing.js";

export const LEAD_SOURCING_SLUG = "lead-sourcing";

/** An origin that spent this many times the best origin's cost per positive reply with none is dropped. */
export const NO_RETURN_SPEND_MULTIPLE = 3;

/** The ROI evidence is re-read at most this often (it moves with replies, not by the minute). */
export const EVIDENCE_TTL_MS = 60 * 60_000;

export type ChoiceBasis = "sources_on_at_switch" | "every_origin";

export type OriginReason =
  | "best_cost_per_positive_reply"
  | "positive_replies_measured"
  | "still_learning"
  | "no_measured_source_yet"
  | "no_evidence_read"
  | "spent_without_positive_reply";

export interface OriginDecision {
  chosen: boolean;
  reason: OriginReason;
  evidence: OriginEvidence | null;
  /** The best origin's cost per positive reply the rule compared against (null when no origin has one). */
  bestCostPerPositiveReplyUsd: number | null;
}

/**
 * PURE: which origins of the universe Lead Sourcing uses, and why (see the header). `evidence` null = nothing
 * read: every origin of the universe is used.
 */
export function decideLeadSourcing(
  universe: readonly string[],
  evidence: ReadonlyMap<string, OriginEvidence> | null
): { chosen: string[]; reasons: Record<string, OriginDecision> } {
  const reasons: Record<string, OriginDecision> = {};
  if (!evidence) {
    for (const o of universe) reasons[o] = { chosen: true, reason: "no_evidence_read", evidence: null, bestCostPerPositiveReplyUsd: null };
    return { chosen: [...universe].sort(), reasons };
  }
  let best: { origin: string; cpr: number } | null = null;
  for (const o of universe) {
    const e = evidence.get(o);
    if (!e || e.positiveReplies <= 0) continue;
    const cpr = e.endToEndCostUsd / e.positiveReplies;
    if (!best || cpr < best.cpr || (cpr === best.cpr && o < best.origin)) best = { origin: o, cpr };
  }
  for (const o of universe) {
    const e = evidence.get(o) ?? null;
    const bestCpr = best?.cpr ?? null;
    let decision: OriginDecision;
    if (best && o === best.origin) decision = { chosen: true, reason: "best_cost_per_positive_reply", evidence: e, bestCostPerPositiveReplyUsd: bestCpr };
    else if (e && e.positiveReplies > 0) decision = { chosen: true, reason: "positive_replies_measured", evidence: e, bestCostPerPositiveReplyUsd: bestCpr };
    else if (!best) decision = { chosen: true, reason: "no_measured_source_yet", evidence: e, bestCostPerPositiveReplyUsd: null };
    else if (e && e.endToEndCostUsd >= NO_RETURN_SPEND_MULTIPLE * best.cpr) {
      decision = { chosen: false, reason: "spent_without_positive_reply", evidence: e, bestCostPerPositiveReplyUsd: bestCpr };
    } else decision = { chosen: true, reason: "still_learning", evidence: e, bestCostPerPositiveReplyUsd: bestCpr };
    reasons[o] = decision;
  }
  const chosen = universe.filter((o) => reasons[o].chosen).sort();
  return { chosen, reasons };
}

export interface LeadSourcingScope {
  orgId: string;
  brandId: string;
  offerId: string;
}

// One decision per scope at a time in this process (the reconcile and a serve's read can meet).
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  void next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  });
  return next;
}

async function loadChoice(scope: LeadSourcingScope): Promise<LeadSourcingChoice | null> {
  const [row] = await db
    .select()
    .from(leadSourcingChoices)
    .where(
      and(
        eq(leadSourcingChoices.orgId, scope.orgId),
        eq(leadSourcingChoices.brandId, scope.brandId),
        eq(leadSourcingChoices.offerId, scope.offerId)
      )
    );
  return row ?? null;
}

/**
 * The scope's decision, created on first sight: the universe is the origins this service last applied ON for the
 * offer (the brand's sources at the switch), else every origin Lead Sourcing may use; every origin of it is used
 * until evidence is read.
 */
export async function ensureLeadSourcingChoice(scope: LeadSourcingScope, campaignId: string | null): Promise<LeadSourcingChoice> {
  return withLock(`${scope.orgId}:${scope.brandId}:${scope.offerId}`, async () => {
    const existing = await loadChoice(scope);
    if (existing) return existing;
    const { origins: usable } = await fetchLeadSourcingOrigins();
    const states = await db
      .select({ originSlug: sourceCampaignStates.originSlug, status: sourceCampaignStates.status })
      .from(sourceCampaignStates)
      .where(
        and(
          eq(sourceCampaignStates.orgId, scope.orgId),
          eq(sourceCampaignStates.brandId, scope.brandId),
          eq(sourceCampaignStates.offerId, scope.offerId)
        )
      );
    const onAtSwitch = states.filter((s) => s.status === "on" && usable.includes(s.originSlug)).map((s) => s.originSlug).sort();
    const basis: ChoiceBasis = onAtSwitch.length > 0 ? "sources_on_at_switch" : "every_origin";
    const universe = basis === "sources_on_at_switch" ? onAtSwitch : [...usable].sort();
    const { chosen, reasons } = decideLeadSourcing(universe, null);
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .insert(leadSourcingChoices)
        .values({ ...scope, campaignId, basis, universeOriginSlugs: universe, chosenOriginSlugs: chosen, reasons, decidedAt: now, updatedAt: now })
        .onConflictDoNothing();
      await tx.insert(leadSourcingChoiceChanges).values({ ...scope, fromOriginSlugs: null, toOriginSlugs: chosen, reasons });
    });
    console.log(
      `[human-service] lead_sourcing.chosen org=${scope.orgId} brand=${scope.brandId} offer=${scope.offerId} basis=${basis} universe=${universe.join(",") || "-"} chosen=${chosen.join(",") || "-"}`
    );
    const row = await loadChoice(scope);
    if (!row) throw new Error(`lead sourcing choice for offer ${scope.offerId} vanished right after it was written`);
    return row;
  });
}

/**
 * Re-decide on the measured ROI when the evidence is older than EVIDENCE_TTL_MS. Needs a real caller identity
 * (features-service's money read tracks a run). The evidence unreadable = the decision stands as last decided,
 * logged loud (it is a decision already taken on evidence, never an invented one).
 */
export async function refreshLeadSourcingChoice(
  scope: LeadSourcingScope,
  identity: { userId: string; runId: string },
  now: Date = new Date()
): Promise<LeadSourcingChoice> {
  return withLock(`${scope.orgId}:${scope.brandId}:${scope.offerId}`, async () => {
    const row = await loadChoice(scope);
    if (!row) throw new Error(`no lead sourcing choice for offer ${scope.offerId}: ensureLeadSourcingChoice first`);
    if (row.evidenceAt && now.getTime() - row.evidenceAt.getTime() < EVIDENCE_TTL_MS) return row;
    let evidence: Map<string, OriginEvidence>;
    try {
      evidence = await fetchOfferSourcingEvidence({ ...scope, ...identity });
    } catch (err) {
      console.error(
        `[human-service] lead_sourcing.evidence_unreadable org=${scope.orgId} brand=${scope.brandId} offer=${scope.offerId}: ${err instanceof Error ? err.message : String(err)} (decision of ${row.decidedAt.toISOString()} stands)`
      );
      return row;
    }
    const { chosen, reasons } = decideLeadSourcing(row.universeOriginSlugs, evidence);
    const changed = chosen.join(",") !== [...row.chosenOriginSlugs].sort().join(",");
    await db.transaction(async (tx) => {
      await tx
        .update(leadSourcingChoices)
        .set({ chosenOriginSlugs: chosen, reasons, evidenceAt: now, ...(changed ? { decidedAt: now } : {}), updatedAt: now })
        .where(
          and(
            eq(leadSourcingChoices.orgId, scope.orgId),
            eq(leadSourcingChoices.brandId, scope.brandId),
            eq(leadSourcingChoices.offerId, scope.offerId)
          )
        );
      if (changed) {
        await tx.insert(leadSourcingChoiceChanges).values({ ...scope, fromOriginSlugs: row.chosenOriginSlugs, toOriginSlugs: chosen, reasons });
      }
    });
    if (changed) {
      console.log(
        `[human-service] lead_sourcing.rechosen org=${scope.orgId} brand=${scope.brandId} offer=${scope.offerId} from=${row.chosenOriginSlugs.join(",") || "-"} to=${chosen.join(",") || "-"}`
      );
    }
    return (await loadChoice(scope))!;
  });
}

/** The scope's stored decision, or null when Lead Sourcing never ran for it. */
export async function readLeadSourcingChoice(scope: LeadSourcingScope): Promise<LeadSourcingChoice | null> {
  return loadChoice(scope);
}
