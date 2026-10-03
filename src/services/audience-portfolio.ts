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
//   - SIGNAL: one audience per buying signal (hiring / job_change / funding)
//     whose coverage for the WHOLE ICP reaches SIGNAL_MIN_COMPANIES distinct
//     companies (owner threshold 2026-10-03: below it the measurement costs
//     more than it can return). apollo-service owns the signal (vocabulary,
//     date filters, rolling window, coverage count); the ICP it is measured on
//     is one apollo audience built from the ICP text by the same exploration +
//     chooser every pointer build uses.
//
// Every audience of the portfolio carries ONE identical `nl_prompt` (the target
// the pre-pay screen judges each teaser against): the person-level restatement
// of the ICP (audience-target.ts), drafted once. Adopted rows keep theirs when
// they already share one; otherwise all of them are given the fresh draft.
//
// No-repeat across the portfolio needs nothing new: suppression is per BRAND
// (brand_suppressions), so a person served under one audience is excluded,
// before any reveal is paid, under every other audience of the brand.
//
// The call answers once the COLD audiences exist (status `building`); the
// signal part (one Apollo exploration of the whole ICP: minutes) finishes in the
// background and flips the record to `ready`. Idempotent per (org, brand, offer)
// through `audience_portfolios`: a replay returns the recorded set and creates
// nothing; a call while one is in flight in this process joins it; a launch
// that crashed half-way (process restart) is resumed from what it recorded
// (cold set, ICP pointer) by the next call.
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
import {
  BUYING_SIGNAL_TYPES,
  createApolloSignalAudience,
  measureSignalCoverage,
  suggestApolloAudience,
  type BuyingSignalType,
  type SignalCoverage,
} from "../lib/apollo-audiences.js";
import { chooseAudienceCandidate } from "./audience-chooser.js";
import { confirmAudienceSplit, proposeAudienceSplit } from "./audience-split.js";
import { ensureCompetitorEngagementAudience } from "./competitor-engagement-audience.js";
import { draftAudienceTarget } from "./audience-target.js";
import { dedupeSegmentNames } from "./audience-refill.js";
import { ensureApolloPointer } from "./audiences.js";
import type { Identity } from "./people-providers.js";
import { completeRun, createRun } from "./runs.js";

type AudienceRow = typeof audiences.$inferSelect;
type PortfolioRow = typeof audiencePortfolios.$inferSelect;

export const PORTFOLIO_COLD_SOURCE = "icp_portfolio";
export const PORTFOLIO_SIGNAL_SOURCE = "icp_portfolio_signal";
/** Split rows a pre-payment flow confirmed: adopted instead of re-created. */
const ADOPTABLE_SOURCE = "split_proposal";
const ADOPTABLE_STATUSES = ["suggested", "active"];

/** Owner threshold (2026-10-03): distinct companies a signal must reach. */
export const SIGNAL_MIN_COMPANIES = 20;

/**
 * Recency window per signal. A job posting goes stale fast (the hiring push is
 * now or never), so 30 days. A new-in-role person keeps rebuilding their stack
 * for about their first quarter, and a funded company spends the round over
 * months, so 90 days for both. Hiring is measured for ANY role: the ICP text
 * names who we write to, not which roles their company hires, and naming roles
 * would be a guess.
 */
export const SIGNAL_WINDOW_DAYS: Record<BuyingSignalType, number> = {
  hiring: 30,
  job_change: 90,
  funding: 90,
};

const SIGNAL_NAMES: Record<BuyingSignalType, string> = {
  hiring: "Hiring now",
  job_change: "New in role",
  funding: "Recently funded",
};

function signalDescription(type: BuyingSignalType, windowDays: number): string {
  const what =
    type === "hiring"
      ? "whose company posted a job opening"
      : type === "job_change"
        ? "who started their current role"
        : "whose company raised its latest funding round";
  return `People in the ideal customer profile ${what} in the last ${windowDays} days.`;
}

export interface SignalOutcome {
  type: BuyingSignalType;
  windowDays: number;
  outcome: "created" | "below_threshold" | "failed";
  /** Verified-email people the signal reaches for the ICP. Null when unmeasured. */
  people: number | null;
  /** Distinct companies of those people. Null when unmeasured. */
  companies: number | null;
  companiesExact: boolean | null;
  audienceId: string | null;
  /** Why a signal is absent: the measured shortfall or the failure. */
  reason: string | null;
}

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

type IcpBase = { ok: true; id: string } | { ok: false; reason: string };

// The call answers as soon as the COLD audiences exist (seconds); the signal
// part waits on one Apollo exploration of the whole ICP (minutes, up to
// apollo-service's 210s bound plus the chooser and the coverage walk), so it
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

  // The ICP's apollo audience only feeds the signals, so it is built alongside
  // the cold part. Its failure is a signal failure, never the launch's: settle
  // it into a value right away (no unhandled rejection if the cold part throws).
  const icpBase: Promise<IcpBase> = portfolio.icpApolloAudienceId
    ? Promise.resolve({ ok: true, id: portfolio.icpApolloAudienceId })
    : buildIcpApolloAudience(icpText, args.brandId, identity).then(
        async (id) => {
          await db
            .update(audiencePortfolios)
            .set({ icpApolloAudienceId: id, updatedAt: new Date() })
            .where(eq(audiencePortfolios.id, portfolio.id));
          return { ok: true as const, id };
        },
        (err) => ({ ok: false as const, reason: errMessage(err) })
      );

  let coldIds = portfolio.coldAudienceIds;
  let target = portfolio.target;
  if (!coldIds) {
    try {
      const cold = await buildColdAudiences(icpText, args, identity);
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

  const background = finishSignals({ portfolio, icpBase, target, args, identity, closeRun })
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
  icpBase: Promise<IcpBase>;
  target: string | null;
  args: LaunchPortfolioArgs;
  identity: Identity;
  closeRun: (status: "completed" | "failed") => Promise<void>;
}): Promise<void> {
  const { portfolio, args } = input;
  try {
    const signals = await buildSignalAudiences({
      base: await input.icpBase,
      target: input.target,
      args,
      identity: input.identity,
    });
    // The competitor-engagement audience (competitor-engagement-audience.ts):
    // free to create, built from brand-service's competitor pages. Never fails
    // the launch: every outcome (none found, not computed yet, failed) is logged
    // there, and the recurring sweep retries the ones that are not final.
    await ensureCompetitorEngagementAudience({
      orgId: args.orgId,
      userId: args.userId,
      brandId: args.brandId,
      offerId: args.offerId,
      target: input.target ?? portfolio.icpText,
      identity: input.identity,
    });
    await db
      .update(audiencePortfolios)
      .set({ signals: signals as unknown as Array<Record<string, unknown>>, status: "ready", updatedAt: new Date() })
      .where(eq(audiencePortfolios.id, portfolio.id));
    console.log(
      `[human-service] audience_portfolio.ready org=${args.orgId} brand=${args.brandId} offer=${args.offerId} ms=${Date.now() - portfolio.createdAt.getTime()} signals=${signals
        .map((s) => `${s.type}:${s.outcome}${s.companies !== null ? `(${s.companies}co)` : ""}`)
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
    for (const row of adoptable) {
      void ensureApolloPointer(row, buildIdentity).catch((err) =>
        console.error(`[human-service] audience_portfolio.pointer_build.failed audience=${row.id}`, err)
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
  }
  return { ids: created.map((r) => r.id), target };
}

/**
 * The whole ICP as one apollo-service audience: the exploration apollo-service
 * runs, then the chooser picks among its rounds (apollo's own top-level pick is
 * the argmax-count the chooser replaced). Only the pointer is kept; it is the
 * base every signal is measured on, never an audience of its own here.
 */
async function buildIcpApolloAudience(
  icpText: string,
  brandId: string,
  identity: Identity
): Promise<string> {
  const apollo = await suggestApolloAudience({
    name: "Ideal customer profile",
    description: icpText,
    brandId,
    identity,
  });
  if (apollo.candidates.length <= 1) return apollo.apolloAudienceId;
  const chosen = await chooseAudienceCandidate({
    nlPrompt: icpText,
    candidates: apollo.candidates,
    identity,
  });
  console.log(
    `[human-service] audience_portfolio.icp_base chooser picked attempt ${chosen.chosen}/${apollo.candidates.length} (count ${chosen.candidate.count}): ${chosen.why}`
  );
  return chosen.candidate.apolloAudienceId;
}

async function buildSignalAudiences(input: {
  base: { ok: true; id: string } | { ok: false; reason: string };
  target: string | null;
  args: LaunchPortfolioArgs;
  identity: Identity;
}): Promise<SignalOutcome[]> {
  const { base, args, identity } = input;
  const failedAll = (reason: string): SignalOutcome[] => {
    console.error(
      `[human-service] audience_portfolio.signals_failed org=${args.orgId} brand=${args.brandId} offer=${args.offerId} reason=${JSON.stringify(reason)}`
    );
    return BUYING_SIGNAL_TYPES.map((type) => ({
      type,
      windowDays: SIGNAL_WINDOW_DAYS[type],
      outcome: "failed",
      people: null,
      companies: null,
      companiesExact: null,
      audienceId: null,
      reason,
    }));
  };
  if (!base.ok) return failedAll(`ICP build failed: ${base.reason}`);

  let coverage: SignalCoverage[];
  try {
    const windows = [...new Set(Object.values(SIGNAL_WINDOW_DAYS))].sort((a, b) => a - b);
    coverage = (await measureSignalCoverage({ apolloAudienceId: base.id, windowDays: windows, identity }))
      .signals;
  } catch (err) {
    return failedAll(`coverage read failed: ${errMessage(err)}`);
  }

  const outcomes: SignalOutcome[] = [];
  for (const type of BUYING_SIGNAL_TYPES) {
    const windowDays = SIGNAL_WINDOW_DAYS[type];
    const measured = coverage.find((c) => c.type === type && c.windowDays === windowDays);
    if (!measured) {
      outcomes.push(failedOutcome(args, type, windowDays, "apollo-service returned no coverage for this signal"));
      continue;
    }
    const common = {
      type,
      windowDays,
      people: measured.count,
      companies: measured.companies,
      companiesExact: measured.companiesExact,
    };
    if (measured.companies < SIGNAL_MIN_COMPANIES) {
      console.log(
        `[human-service] audience_portfolio.signal_below_threshold org=${args.orgId} brand=${args.brandId} type=${type} companies=${measured.companies} people=${measured.count} min=${SIGNAL_MIN_COMPANIES}`
      );
      outcomes.push({
        ...common,
        outcome: "below_threshold",
        audienceId: null,
        reason: `${measured.companies} companies < ${SIGNAL_MIN_COMPANIES}`,
      });
      continue;
    }
    try {
      const row = await createSignalAudienceRow({
        type,
        windowDays,
        baseApolloAudienceId: base.id,
        target: input.target,
        args,
        identity,
      });
      outcomes.push({ ...common, outcome: "created", audienceId: row.id, reason: null });
    } catch (err) {
      outcomes.push({ ...failedOutcome(args, type, windowDays, errMessage(err)), ...common, outcome: "failed" });
    }
  }
  return outcomes;
}

function failedOutcome(
  args: LaunchPortfolioArgs,
  type: BuyingSignalType,
  windowDays: number,
  reason: string
): SignalOutcome {
  console.error(
    `[human-service] audience_portfolio.signal_failed org=${args.orgId} brand=${args.brandId} type=${type} reason=${JSON.stringify(reason)}`
  );
  return {
    type,
    windowDays,
    outcome: "failed",
    people: null,
    companies: null,
    companiesExact: null,
    audienceId: null,
    reason,
  };
}

async function createSignalAudienceRow(input: {
  type: BuyingSignalType;
  windowDays: number;
  baseApolloAudienceId: string;
  target: string | null;
  args: LaunchPortfolioArgs;
  identity: Identity;
}): Promise<AudienceRow> {
  const { args } = input;
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
  const [name] = dedupeSegmentNames([SIGNAL_NAMES[input.type]], taken.map((t) => t.name));
  const apollo = await createApolloSignalAudience({
    baseApolloAudienceId: input.baseApolloAudienceId,
    brandId: args.brandId,
    name,
    type: input.type,
    windowDays: input.windowDays,
    identity: input.identity,
  });
  const [row] = await db
    .insert(audiences)
    .values({
      orgId: args.orgId,
      brandId: args.brandId,
      offerId: args.offerId,
      name,
      description: signalDescription(input.type, input.windowDays),
      nlPrompt: input.target,
      provider: "apollo",
      apolloAudienceId: apollo.apolloAudienceId,
      filters: apollo.filters,
      apolloCount: apollo.count,
      countedAt: new Date(),
      status: "active",
      source: PORTFOLIO_SIGNAL_SOURCE,
      createdByUserId: args.userId,
    })
    .returning();
  console.log(
    `[human-service] audience_portfolio.signal_created org=${args.orgId} brand=${args.brandId} type=${input.type} audience=${row.id} count=${apollo.count}`
  );
  return row;
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
