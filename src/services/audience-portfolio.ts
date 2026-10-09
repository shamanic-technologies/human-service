// ICP audience PORTFOLIO at launch — POST /orgs/audiences/portfolio.
//
// When a customer pays, they have validated ONE thing: a plain-English text
// saying who they sell to (their ICP). Campaign-service spends the brand's one
// daily budget on whichever audience earns the best return, so the launch needs
// SEVERAL active audiences, all derived from that text. Owner decision
// (2026-10-03): the customer validates only the ICP text; we pick the mix.
//
// The portfolio is:
//   - COLD: the existing non-overlapping split of the ICP (audience-split.ts).
//     When the brand's /get-started flow already confirmed the split for this
//     (brand, offer) before payment (rows `source='split_proposal'`, status
//     suggested/active), those rows are ADOPTED and activated, never copied.
//     Otherwise the split is proposed and confirmed here, every segment kept.
//   - SIGNAL: per cold audience (a client PROFILE, profile-sources.ts), one list
//     per buying signal (hiring / job_change / funding) whose coverage for THAT
//     profile reaches SIGNAL_MIN_COMPANIES distinct companies (owner threshold
//     2026-10-03: below it the measurement costs more than it can return). Each
//     list is built on the profile's own Apollo audience and screened against
//     the profile's own text, so pausing a profile stops its signal lists too
//     (owner 2026-10-09). apollo-service owns the signal (vocabulary, date
//     filters, rolling window, coverage count).
//
// Every cold audience carries ONE identical `nl_prompt` (the shared target the
// split was drafted from): the person-level restatement of the ICP
// (audience-target.ts), drafted once. Adopted rows keep theirs when they already
// share one; otherwise all of them are given the fresh draft.
//
// No-repeat across the portfolio needs nothing new: suppression is per BRAND
// (brand_suppressions), so a person served under one audience is excluded,
// before any reveal is paid, under every other audience of the brand.
//
// The call answers once the COLD audiences exist (status `building`); the
// signal part (it waits on each profile's Apollo build: minutes) finishes in the
// background and flips the record to `ready`. Idempotent per (org, brand, offer)
// through `audience_portfolios`: a replay returns the recorded set and creates
// nothing; a call while one is in flight in this process joins it; a launch
// that crashed half-way (process restart) is resumed from what it recorded
// (cold set) by the next call.
//
// Failure split (brief no-gos): a failure of the COLD part fails the call loud;
// a failure of any SIGNAL read is recorded as that signal's `failed` outcome,
// logged loud, and the cold audiences still ship.
//
// Cost: nothing is declared here. LLM calls (split, icon judgment, target
// draft, chooser) are declared by chat-service, the Apollo exploration by
// apollo-service, both org-billed on this request's identity (under an
// `audience-portfolio-launch` run when the caller sent none). The signal
// coverage read and the signal audience's size estimate are free Apollo teaser
// searches on apollo-service's side.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiencePortfolios, audiences } from "../db/schema.js";
import type { BuyingSignalType } from "../lib/apollo-audiences.js";
import { confirmAudienceSplit, proposeAudienceSplit } from "./audience-split.js";
import { ensureCompetitorEngagementAudience } from "./competitor-engagement-audience.js";
import { draftAudienceTarget } from "./audience-target.js";
import { dedupeSegmentNames } from "./audience-refill.js";
import { ensureApolloPointer } from "./audiences.js";
import type { Identity } from "./people-providers.js";
import { completeRun, createRun } from "./runs.js";
import { sourcingOriginSlug, withSourcingOrigin } from "./sourcing-origin.js";
import { audienceTargetFields, ensureTargetText } from "./audience-target-text.js";
import {
  ensureProfileSignalLists,
  PROFILE_SIGNAL_SOURCE,
  SIGNAL_MIN_COMPANIES,
  SIGNAL_WINDOW_DAYS,
  type ProfileSignalOutcome,
} from "./profile-sources.js";

type AudienceRow = typeof audiences.$inferSelect;
type PortfolioRow = typeof audiencePortfolios.$inferSelect;

export const PORTFOLIO_COLD_SOURCE = "icp_portfolio";
export const PORTFOLIO_SIGNAL_SOURCE = PROFILE_SIGNAL_SOURCE;
export { SIGNAL_MIN_COMPANIES, SIGNAL_WINDOW_DAYS };
/** Split rows a pre-payment flow confirmed: adopted instead of re-created. */
const ADOPTABLE_SOURCE = "split_proposal";
const ADOPTABLE_STATUSES = ["suggested", "active"];

/** One (profile, buying signal) pair of the launch. */
export type SignalOutcome = ProfileSignalOutcome;

export interface PortfolioAudience {
  row: AudienceRow;
  kind: "cold" | "signal";
  signal: { type: BuyingSignalType; windowDays: number } | null;
  /** True when the cold row existed before the launch and was adopted. */
  adopted: boolean;
}

export interface PortfolioResult {
  portfolioId: string;
  /** building = cold audiences live, signal audiences still being measured;
   * ready = every signal has its outcome. */
  status: "building" | "ready";
  replayed: boolean;
  target: string | null;
  audiences: PortfolioAudience[];
  signals: SignalOutcome[];
}

export interface LaunchPortfolioArgs {
  orgId: string;
  userId: string;
  brandId: string;
  offerId: string;
  icpText: string;
  identity: Identity;
}

// The call answers as soon as the COLD audiences exist (seconds); the signal
// part waits on each profile's Apollo build (minutes, up to apollo-service's
// 210s bound plus the chooser and the coverage walk), so it
// finishes in the background and a replay reads it back. A caller that times
// out or disconnects changes nothing: both phases run to completion server-side.
const coldInFlight = new Map<string, Promise<PortfolioResult>>();
const signalsInFlight = new Map<string, Promise<void>>();

export async function launchAudiencePortfolio(
  args: LaunchPortfolioArgs
): Promise<PortfolioResult> {
  const key = scopeKey(args);
  const running = coldInFlight.get(key);
  if (running) return running.then((r) => ({ ...r, replayed: true }));
  const launch = runLaunch(args, key).finally(() => coldInFlight.delete(key));
  coldInFlight.set(key, launch);
  return launch;
}

/** Resolves once every background signal phase of this process has settled. */
export async function settlePortfolioBackground(): Promise<void> {
  await Promise.allSettled([...signalsInFlight.values()]);
}

function scopeKey(a: { orgId: string; brandId: string; offerId: string }): string {
  return `${a.orgId}:${a.brandId}:${a.offerId}`;
}

async function loadPortfolio(args: LaunchPortfolioArgs): Promise<PortfolioRow | undefined> {
  const [row] = await db
    .select()
    .from(audiencePortfolios)
    .where(
      and(
        eq(audiencePortfolios.orgId, args.orgId),
        eq(audiencePortfolios.brandId, args.brandId),
        eq(audiencePortfolios.offerId, args.offerId)
      )
    );
  return row;
}

async function runLaunch(args: LaunchPortfolioArgs, key: string): Promise<PortfolioResult> {
  const existing = await loadPortfolio(args);
  if (existing?.status === "ready") return readPortfolio(existing, true);
  // Signals still running in this process: report where the launch stands.
  if (existing?.coldAudienceIds && signalsInFlight.has(key)) return readPortfolio(existing, true);
  if (!existing) {
    await db
      .insert(audiencePortfolios)
      .values({ orgId: args.orgId, brandId: args.brandId, offerId: args.offerId, icpText: args.icpText })
      .onConflictDoNothing();
  }
  const portfolio = (await loadPortfolio(args))!;
  if (portfolio.status === "ready") return readPortfolio(portfolio, true);
  if (existing && existing.icpText !== args.icpText) {
    // A resumed launch finishes what it started, on the text it started with.
    console.warn(
      `[human-service] audience_portfolio.resume_icp_differs portfolio=${portfolio.id} — resuming with the recorded ICP text`
    );
  }
  const icpText = portfolio.icpText;

  // chat-service and apollo-service require an x-run-id: open our own,
  // org-billed, when the caller sent none. It closes when the background
  // signal phase ends.
  const tracking = { ...(args.identity.workflowTracking ?? {}), brandIds: [args.brandId] };
  let identity: Identity = { ...args.identity, orgId: args.orgId, userId: args.userId, workflowTracking: tracking };
  let ownRunId: string | null = null;
  if (!identity.runId) {
    ownRunId = await createRun({
      orgId: args.orgId,
      userId: args.userId,
      taskName: "audience-portfolio-launch",
      workflowTracking: tracking,
    });
    if (!ownRunId) {
      throw new Error("runs-service did not open a run for the audience portfolio launch");
    }
    identity = { ...identity, runId: ownRunId };
  }
  const runIdentity = { orgId: args.orgId, userId: args.userId, workflowTracking: tracking };
  const closeRun = async (status: "completed" | "failed") => {
    if (ownRunId) await completeRun(ownRunId, status, runIdentity);
  };
  // The launch builds lists of several origins, so its own run carries none; each
  // part's calls carry the origin of the lists it builds (the cold split: Apollo
  // search; the coverage + signal rows: Apollo buying signals; the
  // competitor-engagement audience labels itself). Unresolvable ⟹ fail loud.
  let coldIdentity: Identity;
  let signalIdentity: Identity;
  let signalOrigin: string;
  try {
    coldIdentity = withSourcingOrigin(identity, await sourcingOriginSlug("apollo_search"));
    signalOrigin = await sourcingOriginSlug("apollo_buying_signal");
    signalIdentity = withSourcingOrigin(identity, signalOrigin);
  } catch (err) {
    await closeRun("failed");
    throw err;
  }

  let coldIds = portfolio.coldAudienceIds;
  let target = portfolio.target;
  if (!coldIds) {
    try {
      const cold = await buildColdAudiences(icpText, args, coldIdentity);
      coldIds = cold.ids;
      target = cold.target;
    } catch (err) {
      await closeRun("failed");
      throw err;
    }
    await db
      .update(audiencePortfolios)
      .set({ coldAudienceIds: coldIds, target, updatedAt: new Date() })
      .where(eq(audiencePortfolios.id, portfolio.id));
  }

  const background = finishSignals({ portfolio, args, identity, signalIdentity, signalOrigin, closeRun })
    .catch((err) =>
      // The row stays `building` with its cold set: the next call resumes.
      console.error(`[human-service] audience_portfolio.background_failed portfolio=${portfolio.id}`, err)
    )
    .finally(() => signalsInFlight.delete(key));
  signalsInFlight.set(key, background);

  return readPortfolio({ ...portfolio, coldAudienceIds: coldIds, target, status: "building" }, Boolean(existing));
}

async function finishSignals(input: {
  portfolio: PortfolioRow;
  args: LaunchPortfolioArgs;
  identity: Identity;
  signalIdentity: Identity;
  signalOrigin: string;
  closeRun: (status: "completed" | "failed") => Promise<void>;
}): Promise<void> {
  const { portfolio, args } = input;
  try {
    // One list per (live profile, buying signal) above threshold. Waits on each
    // profile's background Apollo build (deduped, never built twice).
    const signals = await ensureProfileSignalLists({
      orgId: args.orgId,
      brandId: args.brandId,
      offerId: args.offerId,
      userId: args.userId,
      identity: input.signalIdentity,
      originSlug: input.signalOrigin,
    });
    // The competitor-engagement lists, one per profile
    // (competitor-engagement-audience.ts): free to create, built from
    // brand-service's competitor pages. Never fails the launch: every outcome
    // (none found, not computed yet, failed) is logged there, and the recurring
    // sweep retries the ones that are not final.
    await ensureCompetitorEngagementAudience({
      orgId: args.orgId,
      userId: args.userId,
      brandId: args.brandId,
      offerId: args.offerId,
      identity: input.identity,
    });
    await db
      .update(audiencePortfolios)
      .set({ signals: signals as unknown as Array<Record<string, unknown>>, status: "ready", updatedAt: new Date() })
      .where(eq(audiencePortfolios.id, portfolio.id));
    console.log(
      `[human-service] audience_portfolio.ready org=${args.orgId} brand=${args.brandId} offer=${args.offerId} ms=${Date.now() - portfolio.createdAt.getTime()} signals=${signals
        .map((s) => `${s.profileName}/${s.type}:${s.outcome}${s.companies !== null ? `(${s.companies}co)` : ""}`)
        .join(",")}`
    );
    await input.closeRun("completed");
  } catch (err) {
    await input.closeRun("failed");
    throw err;
  }
}

/**
 * Adopt the split a pre-payment flow already confirmed for this (brand, offer),
 * else propose + confirm it. Returns the cold ids and the ONE target they share.
 * Any failure propagates: the launch fails loud without its cold audiences.
 */
async function buildColdAudiences(
  icpText: string,
  args: LaunchPortfolioArgs,
  identity: Identity
): Promise<{ ids: string[]; target: string | null }> {
  const adoptable = await db
    .select()
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, args.orgId),
        eq(audiences.brandId, args.brandId),
        eq(audiences.offerId, args.offerId),
        eq(audiences.source, ADOPTABLE_SOURCE),
        inArray(audiences.status, ADOPTABLE_STATUSES)
      )
    );

  // Background Apollo builds open their own runs (the launch's run completes
  // before they land): org-billed with the caller's org + user.
  const buildIdentity: Identity = { orgId: args.orgId, userId: args.userId };

  if (adoptable.length > 0) {
    const prompts = new Set(adoptable.map((a) => a.nlPrompt?.trim() ?? ""));
    const shared = prompts.size === 1 ? [...prompts][0] : "";
    const target =
      shared ||
      ((await draftAudienceTarget({
        customerTarget: icpText,
        brandId: args.brandId,
        offerId: args.offerId,
        identity,
      })) ?? icpText);
    const ids = adoptable.map((a) => a.id);
    await db
      .update(audiences)
      .set({ status: "active", nlPrompt: target, updatedAt: new Date() })
      .where(inArray(audiences.id, ids));
    console.log(
      `[human-service] audience_portfolio.cold_adopted org=${args.orgId} brand=${args.brandId} offer=${args.offerId} adopted=${ids.length} target=${shared ? "kept" : "redrafted"}`
    );
    // Adopted together, the rows are now several sharing ONE target: a row that
    // carries its own segment sentence but holds the whole target as its text
    // (a one-segment confirm wrote it when it was alone) gets its own segment
    // text drafted, else the screen would judge it against every profile
    // (prod 2026-10-09, "Heads of QA" screened against "... and CTOs"). A row
    // with no segment sentence keeps the target AS its text.
    const ownText = adoptable.filter((a) => a.targetTextOrigin === "audience_target");
    const toSegment = ids.length > 1 ? ownText.filter((a) => a.description?.trim()).map((a) => a.id) : [];
    if (toSegment.length > 0) {
      await db
        .update(audiences)
        .set({ targetText: null, targetTextOrigin: null })
        .where(inArray(audiences.id, toSegment));
    }
    const keepOwn = ownText.map((a) => a.id).filter((id) => !toSegment.includes(id));
    if (!shared && keepOwn.length > 0) {
      await db.update(audiences).set(audienceTargetFields(target)).where(inArray(audiences.id, keepOwn));
    }
    for (const row of adoptable) {
      void ensureApolloPointer(row, buildIdentity).catch((err) =>
        console.error(`[human-service] audience_portfolio.pointer_build.failed audience=${row.id}`, err)
      );
      const fresh = toSegment.includes(row.id) ? { targetText: null, targetTextOrigin: null } : {};
      void ensureTargetText({ ...row, ...fresh, nlPrompt: target }, buildIdentity).catch((err) =>
        console.error(`[human-service] audience_portfolio.target_text.failed audience=${row.id}`, err)
      );
    }
    return { ids, target };
  }

  const [drafted, proposal] = await Promise.all([
    draftAudienceTarget({
      customerTarget: icpText,
      brandId: args.brandId,
      offerId: args.offerId,
      identity,
    }),
    proposeAudienceSplit(icpText, identity),
  ]);
  // The offer was found (draftAudienceTarget throws otherwise), so a null draft
  // cannot happen here; the customer's words are the honest fallback anyway.
  const target = drafted ?? icpText;
  const taken = await db
    .select({ name: audiences.name })
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, args.orgId),
        eq(audiences.brandId, args.brandId),
        eq(audiences.offerId, args.offerId)
      )
    );
  const names = dedupeSegmentNames(
    proposal.segments.map((s) => s.name),
    taken.map((t) => t.name)
  );
  const created = await confirmAudienceSplit({
    orgId: args.orgId,
    userId: args.userId,
    brandId: args.brandId,
    offerId: args.offerId,
    targetAudience: target,
    segments: proposal.segments.map((s, i) => ({ name: names[i], description: s.description })),
    source: PORTFOLIO_COLD_SOURCE,
  });
  console.log(
    `[human-service] audience_portfolio.cold_created org=${args.orgId} brand=${args.brandId} offer=${args.offerId} created=${created.length}`
  );
  for (const row of created) {
    void ensureApolloPointer(row, buildIdentity).catch((err) =>
      console.error(`[human-service] audience_portfolio.pointer_build.failed audience=${row.id}`, err)
    );
    void ensureTargetText(row, buildIdentity).catch((err) =>
      console.error(`[human-service] audience_portfolio.target_text.failed audience=${row.id}`, err)
    );
  }
  return { ids: created.map((r) => r.id), target };
}

/** The recorded portfolio, re-read from the audiences it names. */
async function readPortfolio(p: PortfolioRow, replayed: boolean): Promise<PortfolioResult> {
  const signals = (p.signals ?? []) as unknown as SignalOutcome[];
  const coldIds = p.coldAudienceIds ?? [];
  const signalIds = signals.flatMap((s) => (s.audienceId ? [s.audienceId] : []));
  const ids = [...coldIds, ...signalIds];
  const rows = ids.length
    ? await db.select().from(audiences).where(inArray(audiences.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: PortfolioAudience[] = [];
  for (const id of coldIds) {
    const row = byId.get(id);
    if (!row) continue; // hard-deleted since the launch
    out.push({ row, kind: "cold", signal: null, adopted: row.source === ADOPTABLE_SOURCE });
  }
  for (const s of signals) {
    const row = s.audienceId ? byId.get(s.audienceId) : undefined;
    if (!row) continue;
    out.push({ row, kind: "signal", signal: { type: s.type, windowDays: s.windowDays }, adopted: false });
  }
  return {
    portfolioId: p.id,
    status: p.status === "ready" ? "ready" : "building",
    replayed,
    target: p.target,
    audiences: out,
    signals,
  };
}
