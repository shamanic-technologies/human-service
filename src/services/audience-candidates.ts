// Candidate API — the pre-pay frontier handed to lead-service.
//
// WHY. Owner decision 2026-10-07: human-service owns WHO a person is; lead-service
// owns whether a lead MEETS a business condition (the client's criteria AND the
// "does this person belong to the audience" screen, which is qualification). So
// lead-service must see a candidate — who it is and its company — BEFORE the
// paid reveal, and decide. serve-next does teaser + screen + reveal in one call,
// which leaves the caller no moment to look or to decline.
//
// THE FLOW (apollo audiences only — the one provider with a free teaser and a
// separate billed reveal):
//   next    → pop the next buffered free teaser, apply every FREE check
//             serve-next applies (brand suppression, opt-outs + won people, the
//             brand's own company, hard bounces, people already rejected for
//             this audience), and hand it out as an `offered` candidate. No
//             screen, no reveal, no spend.
//   reveal  → the billed reveal, recorded as served exactly as serve-next does
//             (finalizeResolved + membership), same `{status, person, personId}`
//             shape. Claimed atomically before the spend: billed once.
//   decline → written to `audience_screened_out`, the SAME exclusion set the
//             screen writes: never buffered or offered again for this audience,
//             and the audience's Size drops by one, exactly like a screen
//             rejection.
//
// serve-next is UNTOUCHED: it keeps its own screen until lead-service's screen is
// live in prod and no longer calls it. Both paths pop the same buffer (a popped
// teaser is gone from it), so one person is never offered by both.
//
// YIELD. The screen's "this audience has stopped producing people" rule
// (teaser-screening.ts) is re-applied HERE from the declines lead-service sends:
// over the last SCREEN_YIELD_WINDOW decisions under the latest `basis` (the name
// of the question the caller's qualification asks — a new basis starts a new
// window, like a new target text / bar does for the screen), fewer than
// SCREEN_YIELD_MIN_PASSES reveals ⟹ `exhausted`, with the reachable ceiling
// persisted and the refill asked, exactly as serve-next does. Computed here, not
// stated by the caller, because the CONSEQUENCES (Remaining, refill) are ours.

import { and, asc, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db, sql as pg } from "../db/index.js";
import { errorMessage } from "../lib/db-error.js";
import { pgErrorCode } from "../lib/pg-error.js";
import {
  audienceCandidates,
  audienceScreenedOut,
  audienceTeaserScreenings,
  audiences,
  type AudienceCandidate,
  type TeaserSnapshot,
} from "../db/schema.js";
import { partitionSuppressed } from "./suppression.js";
import { passLapsedFreeGates, selectLapsed, type LapsedCursor, type LapsedServe } from "./recontact-rereach.js";
import { isShortenedWindow } from "../lib/recontact-window.js";
import { tagFoundAlreadyTaken } from "./audience-provenance.js";
import { bufferTeasers, popTeaserRow, restoreTeasers, type BufferedTeaser, type PoppedTeaserRow } from "./teaser-buffer.js";
import {
  SCRIPT_PAGE_SIZE,
  SERVICE_RECORD_SHARE,
  WalkScriptError,
  errorMessageOf,
  findWalk,
  recordWalk,
  registerWalk,
  releaseWalk,
  teaserFacts,
  walkNow,
  walkScriptSwitch,
  walkWithScript,
  type DecisionCall,
  type InFlightWalk,
  type WalkVerdict,
} from "./candidate-walk.js";
import { isScreenYieldSpent, SCREEN_YIELD_WINDOW } from "./teaser-screening.js";
import { loadServeExclusions, matchesOptOut } from "./opt-outs.js";
import { filterBounced } from "./bounces.js";
import { isOwnCompany, loadOwnCompany } from "./own-company.js";
import {
  peopleSearch,
  resolveEmail,
  type Identity,
  type PeopleSearchFilters,
  type Person,
  type RevealBlockReason,
} from "./people-providers.js";
import { isLinkedinEngagementFilters } from "../lib/apollo-audiences.js";
import { ensureTargetText, screenTarget } from "./audience-target-text.js";
import { isCrmSourcedFeature } from "./sourcing-origin.js";
import { nextCrmCandidate, revealCrmCandidate, type CrmRevealReason } from "./crm-candidates.js";
import {
  markSourceServed,
  persistSourceExhaustion,
  pickServeSource,
  sourcesOf,
  sourceView,
  type AudienceSource,
} from "./audience-sources.js";
import { providerCanReach, type Reach } from "../lib/reach.js";
import { widenedVerdicts, type EmailVerdict } from "../lib/email-verification.js";
import {
  claimRereach,
  markRereach,
  markRereachOfCandidate,
  recordRereachHandout,
  releaseRereach,
  rereachBlock,
  rereachOfCandidate,
  rereachPerson,
  selectRereachable,
  setRereachCandidate,
} from "./catch-all-rereach.js";
import {
  AudienceNotServableError,
  ensureApolloPointer,
  exhaustOnScreenYield,
  hasUsableEmail,
  needsApolloPointerBuild,
  hasApolloNativeFilters,
  persistReachableCountOnExhaustion,
  noRecentPostsAnswer,
  servedWithPersonId,
} from "./audiences.js";

type AudienceRow = typeof audiences.$inferSelect;

// An offered candidate nobody decided on (the caller died between next and its
// decision) is offered again after this, so a teaser is never lost by a crash.
export const CANDIDATE_OFFER_TTL_MS = 15 * 60_000;
// A reveal claim whose caller died mid-spend may be re-taken after this. The
// reveal itself takes seconds; the claim is what stops a concurrent double bill.
export const CANDIDATE_REVEAL_CLAIM_TTL_MS = 5 * 60_000;

export interface CandidateView {
  candidateId: string;
  audienceId: string;
  // The audience source that found this candidate (null = the audience's own list).
  sourceId: string | null;
  providerPersonId: string;
  linkedinUrl: string | null;
  offeredAt: string;
  person: {
    name: string | null;
    title: string | null;
    headline: string | null;
    seniority: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
  };
  company: {
    name: string | null;
    domain: string | null;
    industry: string | null;
    employees: number | null;
    city: string | null;
    state: string | null;
    country: string | null;
    keywords: string[] | null;
  };
}

export type NextCandidateResult =
  | {
      status: "candidate";
      candidate: CandidateView;
      target: { text: string; field: "target_text" | "nl_prompt" } | null;
    }
  | {
      status: "exhausted";
      candidate: null;
      reason: "pool_exhausted" | "yield_exhausted" | "unreachable_by_provider" | "no_recent_posts";
      target: { text: string; field: "target_text" | "nl_prompt" } | null;
    }
  | {
      status: "pending";
      candidate: null;
      target: { text: string; field: "target_text" | "nl_prompt" } | null;
    };

export class CandidateNotFoundError extends Error {}
export class CandidateStateError extends Error {
  constructor(message: string, readonly currentStatus: string) {
    super(message);
  }
}

function toView(row: AudienceCandidate): CandidateView {
  const t: Partial<TeaserSnapshot> = row.teaser ?? {};
  return {
    candidateId: row.id,
    audienceId: row.audienceId,
    sourceId: row.sourceId ?? null,
    providerPersonId: row.providerPersonId,
    linkedinUrl: row.linkedinUrl,
    offeredAt: row.offeredAt.toISOString(),
    person: {
      name: t.name ?? null,
      title: t.title ?? null,
      headline: t.headline ?? null,
      seniority: t.seniority ?? null,
      city: t.city ?? null,
      state: t.state ?? null,
      country: t.country ?? null,
    },
    company: {
      name: t.organizationName ?? null,
      domain: row.organizationDomain,
      industry: t.organizationIndustry ?? null,
      employees: t.organizationEmployees ?? null,
      city: t.organizationCity ?? null,
      state: t.organizationState ?? null,
      country: t.organizationCountry ?? null,
      keywords: t.organizationKeywords ?? null,
    },
  };
}

// A CRM-sourced serve (the CRM feature identity, or a crm audience) is offered
// through crm-candidates.ts: the hand-out is free and the only paid step (the
// email lookup of a contact added without one) sits at the reveal.
function isCrmCandidateServe(audience: AudienceRow, identity: Identity): boolean {
  return isCrmSourcedFeature(identity.workflowTracking?.featureSlug) || audience.provider === "crm";
}

// Otherwise only an apollo audience has a free teaser and a separate billed
// reveal; apify bills per hit, so there is no free moment to hand out: it keeps
// serve-next.
function assertCandidateProvider(audience: AudienceRow, identity: Identity): void {
  if (audience.provider !== "apollo") {
    throw new AudienceNotServableError(
      "Candidates exist only for apollo and CRM-sourced audiences. Use serve-next for apify."
    );
  }
  if (identity.stepFilter) {
    throw new AudienceNotServableError(
      "A stepFilter needs a CRM-sourced serve; an apollo audience cannot honour it."
    );
  }
}

// linkedin_engagement no-repeat lives in apollo-service keyed on x-audience-id:
// stamp THIS audience on the apollo calls, as serve-next does.
function apolloIdentity(audience: AudienceRow, identity: Identity): Identity {
  if (!isLinkedinEngagementFilters(audience.filters)) return identity;
  return {
    ...identity,
    workflowTracking: { ...(identity.workflowTracking ?? {}), audienceId: audience.id },
  };
}

/**
 * The candidate path's yield, from the caller's decisions under the latest
 * basis. null ⟹ no decision yet.
 */
export async function readCandidateYield(
  audienceId: string,
  // Each source of an audience has its own window (null = the audience's own list).
  sourceId: string | null = null
): Promise<{ screens: number; passes: number; spent: boolean } | null> {
  const ofSource = sourceId ? eq(audienceCandidates.sourceId, sourceId) : isNull(audienceCandidates.sourceId);
  const [latest] = await db
    .select({ basis: audienceCandidates.basis })
    .from(audienceCandidates)
    .where(and(eq(audienceCandidates.audienceId, audienceId), ofSource, isNotNull(audienceCandidates.decidedAt)))
    .orderBy(desc(audienceCandidates.decidedAt))
    .limit(1);
  if (!latest) return null;
  const recent = await db
    .select({ status: audienceCandidates.status })
    .from(audienceCandidates)
    .where(
      and(
        eq(audienceCandidates.audienceId, audienceId),
        ofSource,
        isNotNull(audienceCandidates.decidedAt),
        latest.basis === null
          ? sql`${audienceCandidates.basis} IS NULL`
          : eq(audienceCandidates.basis, latest.basis)
      )
    )
    .orderBy(desc(audienceCandidates.decidedAt))
    .limit(SCREEN_YIELD_WINDOW);
  const screens = recent.length;
  const passes = recent.filter((r) => r.status !== "declined").length;
  return { screens, passes, spent: isScreenYieldSpent({ screens, passes }) };
}

// Re-offer an offered candidate whose offer lapsed (its caller never decided).
// Atomic + SKIP LOCKED so two callers never take the same one.
async function retakeLapsedOffer(
  orgId: string,
  audienceId: string,
  sourceId: string | null
): Promise<AudienceCandidate | null> {
  const cutoff = new Date(Date.now() - CANDIDATE_OFFER_TTL_MS);
  const ofSource = sourceId ? pg`AND source_id = ${sourceId}` : pg`AND source_id IS NULL`;
  const rows = await pg<{ id: string }[]>`
    UPDATE audience_candidates SET offered_at = now()
    WHERE id = (
      SELECT id FROM audience_candidates
      WHERE org_id = ${orgId} AND audience_id = ${audienceId}
        AND status = 'offered' AND offered_at < ${cutoff.toISOString()}::timestamptz ${ofSource}
      ORDER BY offered_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(audienceCandidates).where(eq(audienceCandidates.id, id));
  return row ?? null;
}

// The free checks serve-next runs at POP time, minus the screen. Each one is
// read live, so a teaser buffered before a person opted out / bounced / was
// served under another audience never reaches the caller. Answers the FIRST rule
// it fails (the stored walk script's verdict words), or null when it passes all.
async function firstFailedFreeCheck(
  audience: AudienceRow,
  identity: Identity,
  teaser: BufferedTeaser,
  exclusions: Awaited<ReturnType<typeof loadServeExclusions>>,
  ownCompany: Awaited<ReturnType<typeof loadOwnCompany>>
): Promise<Exclude<WalkVerdict, "offer"> | null> {
  const key = { linkedinUrl: teaser.linkedinUrl, providerPersonId: teaser.providerPersonId };
  // Already taken for the brand (served under another audience): never offered,
  // but this audience found them too (multi-source provenance, no spend).
  const { taken } = await partitionSuppressed(identity.orgId, [audience.brandId], [key], identity.excludeEmailedWithin);
  if (taken.length > 0) {
    await tagFoundAlreadyTaken(identity.orgId, audience.id, "apollo", taken, identity.audienceSourceId ?? null);
    return "taken";
  }
  if (matchesOptOut(exclusions, key)) {
    console.log(
      `[human-service] opt_out.blocked_candidate org=${identity.orgId} audience=${audience.id} person=${teaser.providerPersonId}`
    );
    return "opted_out";
  }
  if (isOwnCompany(ownCompany, { name: teaser.teaser?.organizationName ?? null })) {
    console.log(
      `[human-service] own_company.blocked_candidate org=${identity.orgId} audience=${audience.id} person=${teaser.providerPersonId}`
    );
    return "own_company";
  }
  const [reachable] = await filterBounced(identity, [key]);
  if (!reachable) {
    console.log(
      `[human-service] bounce.blocked_candidate org=${identity.orgId} audience=${audience.id} person=${teaser.providerPersonId}`
    );
    return "bounced";
  }
  // Rejected for this audience already (by the screen, or declined): a teaser
  // buffered before that verdict must not come back.
  const [rejected] = await db
    .select({ id: audienceScreenedOut.id })
    .from(audienceScreenedOut)
    .where(
      and(
        eq(audienceScreenedOut.audienceId, audience.id),
        eq(audienceScreenedOut.providerPersonId, teaser.providerPersonId)
      )
    )
    .limit(1);
  return rejected ? "rejected" : null;
}

// lead-service hangs up on candidates/next after 90 s (CANDIDATE_CALL_TIMEOUT_MS):
// the walk answers `pending` well before that, never after the caller left
// (SLOW-SOURCING-BEYONDLOGIC-1028: a 120 s budget outlived the caller).
export const CANDIDATE_NEXT_BUDGET_MS = 60_000;

/**
 * The next candidate of an apollo audience, free: no screen, no reveal. The
 * caller (route) MUST pass identity.brandIds = [audience.brandId].
 */
export async function nextCandidate(
  audienceIn: AudienceRow,
  identityIn: Identity,
  budgetMs: number = CANDIDATE_NEXT_BUDGET_MS,
  reach: readonly Reach[] = []
): Promise<NextCandidateResult> {
  const deadline = Date.now() + budgetMs;
  if (isCrmCandidateServe(audienceIn, identityIn)) {
    const next = await nextCrmCandidate(audienceIn, identityIn, { reach }, () =>
      retakeLapsedOffer(identityIn.orgId, audienceIn.id, null)
    );
    return next.status === "candidate"
      ? { status: "candidate", candidate: toView(next.row), target: next.target }
      : { status: "exhausted", candidate: null, reason: "pool_exhausted", target: next.target };
  }
  // SOURCES (audience-sources.ts): the slug names WHERE to look; an audience with
  // no source offers from its own list, exactly as before.
  const pick = await pickServeSource(audienceIn, identityIn.workflowTracking?.featureSlug);
  if (pick.kind === "off") {
    console.log(
      `[human-service] audience_source.off org=${identityIn.orgId} audience=${audienceIn.id} path=candidates reason=${JSON.stringify(pick.reason)}`
    );
    return { status: "exhausted", candidate: null, reason: "pool_exhausted", target: screenTarget(audienceIn) };
  }
  if (pick.kind === "sources") {
    return nextCandidateFromSources(audienceIn, pick.sources, identityIn, deadline, budgetMs, reach);
  }
  return nextCandidateFromList(audienceIn, identityIn, deadline, budgetMs, reach);
}

async function nextCandidateFromSources(
  audience: AudienceRow,
  sources: Array<AudienceSource | null>,
  identity: Identity,
  deadline: number,
  budgetMs: number,
  reach: readonly Reach[]
): Promise<NextCandidateResult> {
  let last: NextCandidateResult | null = null;
  let pending: NextCandidateResult | null = null;
  // `null` = the audience's own list (a Lead Sourcing serve mixes both).
  for (const source of sources) {
    const result = source
      ? await nextCandidateFromList(sourceView(audience, source), { ...identity, audienceSourceId: source.id }, deadline, budgetMs, reach)
      : await nextCandidateFromList(audience, identity, deadline, budgetMs, reach);
    if (result.status === "candidate") return result;
    if (result.status === "pending") {
      // Budget spent: stop. A source with nothing to hand out YET (not exhaustion,
      // SLOW-SOURCING-BEYONDLOGIC-1028) lets the next source try within the budget.
      if (Date.now() >= deadline) return result;
      pending = result;
      continue;
    }
    if (source && result.reason === "no_recent_posts") await persistSourceExhaustion(source.id, { reachable: false });
    last = result;
  }
  return pending ?? last!;
}

async function nextCandidateFromList(
  audienceIn: AudienceRow,
  identityIn: Identity,
  deadline: number,
  budgetMs: number,
  reach: readonly Reach[]
): Promise<NextCandidateResult> {
  let audience = audienceIn;
  const sourceId = identityIn.audienceSourceId ?? null;
  assertCandidateProvider(audience, identityIn);
  // The serving pipe writes on a channel apollo's people never carry (src/lib/reach.ts):
  // nothing is popped or offered, so nobody is bought or burned for it.
  if (!providerCanReach("apollo", reach)) {
    console.log(
      `[human-service] reach.provider_cannot_reach org=${identityIn.orgId} audience=${audience.id} provider=apollo reach=${reach.join(",")} path=candidates`
    );
    return { status: "exhausted", candidate: null, reason: "unreachable_by_provider", target: null };
  }
  if (needsApolloPointerBuild(audience)) {
    audience = await ensureApolloPointer(audience, identityIn);
  }
  const storedFilters = (audience.filters ?? null) as Record<string, unknown> | null;
  if (!storedFilters || Object.keys(storedFilters).length === 0) {
    throw new AudienceNotServableError("Audience has no stored filters — cannot serve people.");
  }
  // The text the caller's screen judges against: written now if a segment's
  // background draft has not landed, exactly as serve-next does before screening.
  if (!audience.targetText) {
    audience = { ...audience, targetText: await ensureTargetText(audience, identityIn) };
  }
  const target = screenTarget(audience);
  const identity = apolloIdentity(audience, identityIn);

  // A caller asking for catch-all addresses is first offered the catch-all
  // people this audience already revealed, verified and dropped for the brand
  // (catch-all-rereach.ts): their reveal on this candidate costs nothing.
  if (!sourceId && widenedVerdicts(identity.acceptedEmails).length > 0) {
    const rereach = await offerRereach(audience, identity);
    if (rereach) return { status: "candidate", candidate: toView(rereach), target };
  }

  // A caller stating a window shorter than 3 months (`excludeEmailedWithin`) is
  // first offered the people THIS audience already served whose brand window has
  // lapsed under it (recontact-rereach.ts). Their reveal is an ordinary reveal:
  // apollo-service answers it from its person cache (no credit) and the claim
  // runs under the reveal's window. Absent / 3 months: never runs.
  if (isShortenedWindow(identity.excludeEmailedWithin)) {
    const lapsed = await offerLapsed(audience, identity, sourceId);
    if (lapsed) return { status: "candidate", candidate: toView(lapsed), target };
  }

  const yieldNow = await readCandidateYield(audience.id, sourceId);
  if (yieldNow?.spent) {
    await exhaustOnScreenYield(identity, audience, yieldNow);
    return { status: "exhausted", candidate: null, reason: "yield_exhausted", target };
  }

  const lapsed = await retakeLapsedOffer(identity.orgId, audience.id, sourceId);
  if (lapsed) return { status: "candidate", candidate: toView(lapsed), target };

  const exclusions = await loadServeExclusions(identity);
  const ownCompany = await loadOwnCompany(identity.orgId, [audience.brandId]);
  const apolloSearchParams = hasApolloNativeFilters(audience) ? storedFilters : undefined;
  const apolloFilters = hasApolloNativeFilters(audience) ? {} : (storedFilters as PeopleSearchFilters);

  const walk: Walk = {
    audience,
    identity,
    sourceId,
    deadline,
    budgetMs,
    exclusions,
    ownCompany,
    apolloFilters,
    apolloSearchParams,
    target,
    walked: 0,
    held: [],
    terminal: null,
    offered: null,
  };
  // FACTORY-P3 next outcomes (lead_found): the walk itself runs as the stored script while switched (candidate-walk.ts).
  const choose = await walkScriptSwitch();
  if (choose.switched && choose.dynasty && identity.runId) return walkByScript(choose.dynasty, walk);
  return walkHere(walk);
}

// ─── The walk (FACTORY-P3 next outcomes: lead_found) ──────────────────────────────────────────────────────────────

/** One walk of an apollo audience's teasers, as both our own walk and the stored script's doors hold it. */
interface Walk {
  audience: AudienceRow;
  identity: Identity;
  sourceId: string | null;
  deadline: number;
  budgetMs: number;
  exclusions: Awaited<ReturnType<typeof loadServeExclusions>>;
  ownCompany: Awaited<ReturnType<typeof loadOwnCompany>>;
  apolloFilters: PeopleSearchFilters;
  apolloSearchParams: Record<string, unknown> | undefined;
  target: ReturnType<typeof screenTarget>;
  walked: number;
  /** Teasers popped for the script's current page, not decided yet (restored where they were if undecided). */
  held: PoppedTeaserRow[];
  /** How the walk ended without a candidate (pending: budget / search not ready; exhausted: why). */
  terminal: NextCandidateResult | null;
  offered: AudienceCandidate | null;
}

/**
 * The next teaser of the walk, refilling the buffer from the search when it is empty, or how the walk ends:
 * `pending` (budget spent, search not ready) or `exhausted` (with why). Exactly our walk's own steps.
 */
async function nextTeaser(w: Walk): Promise<{ teaser: PoppedTeaserRow } | { end: NextCandidateResult }> {
  const { audience, identity, sourceId, deadline, budgetMs, target } = w;
  for (;;) {
    if (w.walked > 0 && Date.now() >= deadline) {
      console.log(
        `[human-service] audience.candidate_budget_spent org=${identity.orgId} audience=${audience.id} walked=${w.walked} budgetMs=${budgetMs}`
      );
      return { end: { status: "pending", candidate: null, target } };
    }
    w.walked += 1;
    const teaser = await popTeaserRow(identity.orgId, audience.id, sourceId);
    if (teaser) return { teaser };
    const search = await peopleSearch({
      provider: "apollo",
      filters: w.apolloFilters,
      apolloSearchParams: w.apolloSearchParams,
      audienceId: audience.id,
      deadline,
      identity,
    });
    if (search.people.length === 0 && search.notReady) {
      return { end: { status: "pending", candidate: null, target } };
    }
    if (search.people.length === 0) {
      if (search.noRecentPosts) {
        noRecentPostsAnswer(identity.orgId, audience.id, "candidates");
        return { end: { status: "exhausted", candidate: null, reason: "no_recent_posts", target } };
      }
      if (sourceId) await persistSourceExhaustion(sourceId, { reachable: true });
      else await persistReachableCountOnExhaustion(identity.orgId, audience.id);
      return { end: { status: "exhausted", candidate: null, reason: "pool_exhausted", target } };
    }
    await bufferTeasers(identity.orgId, audience.id, search.people, sourceId);
  }
}

/** Once per (audience, person): the candidate row, or null when this person was already offered / decided. */
async function offerTeaser(w: Walk, teaser: BufferedTeaser): Promise<AudienceCandidate | null> {
  const { audience, identity, sourceId } = w;
  const [row] = await db
    .insert(audienceCandidates)
    .values({
      orgId: identity.orgId,
      audienceId: audience.id,
      providerPersonId: teaser.providerPersonId,
      linkedinUrl: teaser.linkedinUrl,
      teaser: teaser.teaser,
      organizationDomain: teaser.organizationDomain,
      sourceId,
    })
    .onConflictDoNothing({
      target: [audienceCandidates.audienceId, audienceCandidates.providerPersonId],
    })
    .returning();
  if (!row) return null;
  console.log(
    `[human-service] audience.candidate_offered org=${identity.orgId} audience=${audience.id} candidate=${row.id} domain=${row.organizationDomain ? "yes" : "no"}`
  );
  return row;
}

const terminalAnswer = (end: NextCandidateResult): Record<string, unknown> =>
  end.status === "exhausted" ? { status: "exhausted", reason: end.reason ?? null } : { status: "pending" };

/** The walk's material for the stored script (and the record of our own walks, in the same words). */
const walkUnits = (w: Walk, pageSize: number) => ({ ownNames: [...w.ownCompany.names].sort(), window: w.identity.excludeEmailedWithin ?? "3_months", pageSize });

/** Our own walk, one teaser at a time; a share of walks is recorded in the stored script's words (pages of one). */
async function walkHere(w: Walk): Promise<NextCandidateResult> {
  const { audience, identity, sourceId, exclusions, ownCompany, target } = w;
  const calls: DecisionCall[] | null = Math.random() < SERVICE_RECORD_SHARE ? [] : null;
  const finish = async (result: NextCandidateResult, error: string | null = null) => {
    if (calls) {
      await recordWalk({
        orgId: identity.orgId,
        audienceId: audience.id,
        serveRunId: identity.runId ?? null,
        runId: null,
        path: "service",
        units: walkUnits(w, 1),
        calls,
        candidateId: result.status === "candidate" ? result.candidate!.candidateId : null,
        status: result.status,
        error,
      });
    }
    return result;
  };
  try {
    for (;;) {
      const next = await nextTeaser(w);
      if ("end" in next) {
        calls?.push({ name: PAGE_CALL, args: { limit: 1 }, answer: { ok: true, data: terminalAnswer(next.end) } });
        return finish(next.end);
      }
      const teaser = next.teaser;
      if (calls) {
        const facts = await teaserFacts(identity, audience.id, [teaser], exclusions);
        calls.push({ name: PAGE_CALL, args: { limit: 1 }, answer: { ok: true, data: { status: "teasers", now: await walkNow(), teasers: facts } } });
      }
      const failed = await firstFailedFreeCheck(audience, identity, teaser, exclusions, ownCompany);
      if (failed) {
        calls?.push({ name: DECIDE_CALL, args: { verdicts: [{ ref: teaser.providerPersonId, verdict: failed }] }, answer: { ok: true, data: { offered: null } } });
        continue;
      }
      const row = await offerTeaser(w, teaser);
      calls?.push({ name: DECIDE_CALL, args: { verdicts: [{ ref: teaser.providerPersonId, verdict: "offer" }] }, answer: { ok: true, data: { offered: row ? { candidateId: row.id } : null } } });
      if (!row) continue;
      return finish({ status: "candidate", candidate: toView(row), target });
    }
  } catch (error) {
    await finish({ status: "pending", candidate: null, target }, errorMessageOf(error));
    throw error;
  }
  void sourceId;
}

/** The stored script walks; its doors (below) run each page and each decision here. */
async function walkByScript(dynasty: string, w: Walk): Promise<NextCandidateResult> {
  const entry = registerWalk(w);
  const units = walkUnits(w, SCRIPT_PAGE_SIZE);
  try {
    const out = await walkWithScript({ dynasty, identity: w.identity, token: entry.token, ...units });
    const result: NextCandidateResult = w.offered
      ? { status: "candidate", candidate: toView(w.offered), target: w.target }
      : (w.terminal ?? { status: "pending", candidate: null, target: w.target });
    if (out.candidateId && out.candidateId !== w.offered?.id) {
      throw new WalkScriptError(`the walk answered candidate ${out.candidateId}, which it did not offer here`, out.runId);
    }
    await recordWalk({ orgId: w.identity.orgId, audienceId: w.audience.id, serveRunId: w.identity.runId ?? null, runId: out.runId, path: "script", units, calls: entry.calls, candidateId: w.offered?.id ?? null, status: result.status, error: null });
    return result;
  } catch (error) {
    await recordWalk({ orgId: w.identity.orgId, audienceId: w.audience.id, serveRunId: w.identity.runId ?? null, runId: error instanceof WalkScriptError ? error.runId : null, path: "script", units, calls: entry.calls, candidateId: null, status: "error", error: errorMessageOf(error) });
    if (entry.thrown) throw entry.thrown;
    throw error;
  } finally {
    // A page popped and never decided goes back where it was.
    const held = w.held;
    w.held = [];
    await restoreTeasers(held).catch((e) => console.error(`[human-service] walk: undecided teasers NOT restored: ${errorMessageOf(e)}`));
    releaseWalk(entry as InFlightWalk<unknown>);
  }
}

export const PAGE_CALL = "human.walk.page";
export const DECIDE_CALL = "human.walk.decide";

/** The script's page door: up to `limit` teasers with their facts, or how the walk ends. */
export async function walkPageDoor(token: string, limit: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const entry = findWalk<Walk>(token);
  if (!entry) return { status: 409, body: { error: "no walk in flight for this token" } };
  const w = entry.walk;
  const args = { limit };
  try {
    if (w.held.length > 0) return { status: 409, body: { error: "the previous page is not decided" } };
    let data: Record<string, unknown>;
    if (w.terminal) data = terminalAnswer(w.terminal);
    else {
      // The first teaser exactly as our walk takes it (budget, refill from the search, how it ends); the rest of the
      // page only from what the buffer already holds: never a search (nor an exhaustion) our walk would not have made
      // before reaching the person it offers.
      const page: PoppedTeaserRow[] = [];
      const first = await nextTeaser(w);
      if ("end" in first) w.terminal = first.end;
      else {
        page.push(first.teaser);
        while (page.length < Math.max(1, Math.min(limit, 100))) {
          const more = await popTeaserRow(w.identity.orgId, w.audience.id, w.sourceId);
          if (!more) break;
          w.walked += 1;
          page.push(more);
        }
      }
      w.held = page;
      data =
        page.length === 0
          ? terminalAnswer(w.terminal!)
          : { status: "teasers", now: await walkNow(), teasers: await teaserFacts(w.identity, w.audience.id, page, w.exclusions) };
    }
    entry.calls.push({ name: PAGE_CALL, args, answer: { ok: true, data } });
    return { status: 200, body: data };
  } catch (error) {
    entry.thrown = error instanceof Error ? error : new Error(String(error));
    entry.calls.push({ name: PAGE_CALL, args, answer: { ok: false, data: { error: errorMessageOf(error) } } });
    return { status: 502, body: { error: errorMessageOf(error) } };
  }
}

const VERDICTS: readonly WalkVerdict[] = ["taken", "opted_out", "own_company", "bounced", "rejected", "offer"];

/**
 * The script's decide door: the page's verdicts, applied in order as our walk applies them (a taken person tagged as
 * found, the others logged, the first `offer` offered once per (audience, person); a teaser after it goes back).
 */
export async function walkDecideDoor(token: string, verdicts: Array<{ ref: string; verdict: string }>): Promise<{ status: number; body: Record<string, unknown> }> {
  const entry = findWalk<Walk>(token);
  if (!entry) return { status: 409, body: { error: "no walk in flight for this token" } };
  const w = entry.walk;
  const args = { verdicts };
  const page = w.held;
  if (verdicts.length !== page.length || verdicts.some((v, i) => v.ref !== page[i]!.providerPersonId || !VERDICTS.includes(v.verdict as WalkVerdict))) {
    return { status: 400, body: { error: "one known verdict per teaser of the page, in its order" } };
  }
  try {
    let offered: AudienceCandidate | null = null;
    let i = 0;
    for (; i < page.length; i++) {
      const teaser = page[i]!;
      const verdict = verdicts[i]!.verdict as WalkVerdict;
      if (verdict !== "offer") {
        await applyFailedCheck(w, teaser, verdict);
        continue;
      }
      offered = await offerTeaser(w, teaser);
      if (offered) {
        i++;
        break;
      }
    }
    w.held = [];
    if (i < page.length) await restoreTeasers(page.slice(i));
    if (offered) w.offered = offered;
    const data = { offered: offered ? { candidateId: offered.id } : null };
    entry.calls.push({ name: DECIDE_CALL, args, answer: { ok: true, data } });
    return { status: 200, body: data };
  } catch (error) {
    entry.thrown = error instanceof Error ? error : new Error(String(error));
    entry.calls.push({ name: DECIDE_CALL, args, answer: { ok: false, data: { error: errorMessageOf(error) } } });
    return { status: 502, body: { error: errorMessageOf(error) } };
  }
}

/** What our walk does when a free rule fails (the person found already taken is tagged; the rest are logged). */
async function applyFailedCheck(w: Walk, teaser: BufferedTeaser, verdict: WalkVerdict): Promise<void> {
  const { audience, identity } = w;
  if (verdict === "taken") {
    const key = { linkedinUrl: teaser.linkedinUrl, providerPersonId: teaser.providerPersonId };
    const { taken } = await partitionSuppressed(identity.orgId, [audience.brandId], [key], identity.excludeEmailedWithin);
    if (taken.length > 0) await tagFoundAlreadyTaken(identity.orgId, audience.id, "apollo", taken, identity.audienceSourceId ?? null);
    else console.error(`[human-service] walk: the script judged ${teaser.providerPersonId} taken; our suppression read finds no serve in the window (skipped as judged)`);
    return;
  }
  if (verdict === "opted_out") console.log(`[human-service] opt_out.blocked_candidate org=${identity.orgId} audience=${audience.id} person=${teaser.providerPersonId}`);
  if (verdict === "own_company") console.log(`[human-service] own_company.blocked_candidate org=${identity.orgId} audience=${audience.id} person=${teaser.providerPersonId}`);
  if (verdict === "bounced") console.log(`[human-service] bounce.blocked_candidate org=${identity.orgId} audience=${audience.id} person=${teaser.providerPersonId}`);
}

// Offer the next re-reachable catch-all person of this audience as a candidate:
// the candidate row the audience already holds for them (a revealed
// `not_served`) is re-opened in place, else one is written from the stored
// teaser. Each person once per brand (the re-reach ledger).
async function offerRereach(
  audience: AudienceRow,
  identity: Identity
): Promise<AudienceCandidate | null> {
  for (;;) {
    const page = await selectRereachable(
      identity.orgId,
      audience.brandId,
      audience.id,
      widenedVerdicts(identity.acceptedEmails)
    );
    if (page.length === 0) return null;
    for (const serve of page) {
      if (!(await claimRereach(identity.orgId, audience.brandId, audience.id, serve, "candidates", "offered"))) {
        continue;
      }
      const block = await rereachBlock(identity, audience.brandId, rereachPerson(serve));
      if (block) {
        await markRereach(identity.orgId, audience.brandId, serve.emailNorm, "blocked", block);
        console.log(
          `[human-service] catch_all_rereach.blocked org=${identity.orgId} audience=${audience.id} reason=${block} path=candidates`
        );
        continue;
      }
      let row: AudienceCandidate | undefined;
      let previous: unknown = null;
      if (serve.candidateId) {
        const [before] = await db
          .select({ revealResult: audienceCandidates.revealResult })
          .from(audienceCandidates)
          .where(eq(audienceCandidates.id, serve.candidateId));
        previous = before?.revealResult ?? null;
        [row] = await db
          .update(audienceCandidates)
          .set({ status: "offered", offeredAt: new Date(), decidedAt: null, basis: null, revealResult: null })
          .where(and(eq(audienceCandidates.id, serve.candidateId), eq(audienceCandidates.status, "revealed")))
          .returning();
      } else {
        [row] = await db
          .insert(audienceCandidates)
          .values({
            orgId: identity.orgId,
            audienceId: audience.id,
            providerPersonId: serve.providerPersonId,
            linkedinUrl: serve.linkedinUrl,
            teaser: serve.teaser,
            organizationDomain: serve.teaserDomain ?? serve.companyDomain,
          })
          .onConflictDoNothing({
            target: [audienceCandidates.audienceId, audienceCandidates.providerPersonId],
          })
          .returning();
      }
      if (!row) {
        // Taken by a concurrent offer between the read and the write: give the
        // re-reach back, the next read decides again.
        await releaseRereach(identity.orgId, audience.brandId, serve.emailNorm);
        continue;
      }
      await setRereachCandidate(identity.orgId, audience.brandId, serve.emailNorm, row.id, previous);
      console.log(
        `[human-service] catch_all_rereach.offered org=${identity.orgId} audience=${audience.id} candidate=${row.id} leadServe=${serve.leadServeId}`
      );
      return row;
    }
  }
}

// Offer the oldest lapsed person of this audience that passes the free checks:
// their decided candidate row (a `revealed` one) is re-opened in place, else a
// row is written from the stored teaser. null ⟹ nobody left. A person blocked by
// a gate is passed over (the keyset only moves forward inside one call).
async function offerLapsed(
  audience: AudienceRow,
  identity: Identity,
  sourceId: string | null
): Promise<AudienceCandidate | null> {
  const window = identity.excludeEmailedWithin!;
  const exclusions = await loadServeExclusions(identity);
  const ownCompany = await loadOwnCompany(identity.orgId, [audience.brandId]);
  let after: LapsedCursor | null = null;
  for (;;) {
    const page = await selectLapsed(identity.orgId, audience.brandId, audience.id, sourceId, window, after);
    if (page.length === 0) return null;
    after = { anchor: page[page.length - 1].anchor, emailNorm: page[page.length - 1].emailNorm };
    for (const lapsed of await passLapsedFreeGates(identity, audience.brandId, page, exclusions, ownCompany)) {
      const row = await reopenLapsedCandidate(identity.orgId, audience.id, sourceId, lapsed);
      if (!row) continue;
      console.log(
        `[human-service] recontact.offered org=${identity.orgId} audience=${audience.id} candidate=${row.id} window=${window}`
      );
      return row;
    }
  }
}

async function reopenLapsedCandidate(
  orgId: string,
  audienceId: string,
  sourceId: string | null,
  lapsed: LapsedServe
): Promise<AudienceCandidate | undefined> {
  if (lapsed.candidateId) {
    const [row] = await db
      .update(audienceCandidates)
      .set({ status: "offered", offeredAt: new Date(), decidedAt: null, basis: null, revealResult: null })
      .where(and(eq(audienceCandidates.id, lapsed.candidateId), eq(audienceCandidates.status, "revealed")))
      .returning();
    return row;
  }
  const [row] = await db
    .insert(audienceCandidates)
    .values({
      orgId,
      audienceId,
      providerPersonId: lapsed.providerPersonId,
      linkedinUrl: lapsed.linkedinUrl,
      teaser: lapsed.teaser,
      organizationDomain: lapsed.organizationDomain,
      sourceId,
    })
    .onConflictDoNothing({
      target: [audienceCandidates.audienceId, audienceCandidates.providerPersonId],
    })
    .returning();
  return row;
}

async function loadCandidate(
  orgId: string,
  audienceId: string,
  candidateId: string
): Promise<AudienceCandidate> {
  const [row] = await db
    .select()
    .from(audienceCandidates)
    .where(
      and(
        eq(audienceCandidates.id, candidateId),
        eq(audienceCandidates.audienceId, audienceId),
        eq(audienceCandidates.orgId, orgId)
      )
    );
  if (!row) throw new CandidateNotFoundError("Candidate not found");
  return row;
}

export interface RevealCandidateResult {
  // `served` ⟹ the same served person serve-next returns. `not_served` ⟹ the
  // reveal ran (and was billed) but yielded nobody servable: no usable email,
  // not deliverable, or blocked post-pay (suppressed / opted out / won /
  // bounced / own company). Ask for the next candidate.
  status: "served" | "not_served";
  person: Person | null;
  personId?: string;
  // On `served`: the verification verdict of the address handed (internal until
  // the route shapes it; on the wire only when the caller stated acceptedEmails).
  emailVerdict?: EmailVerdict | null;
  // On every `not_served`: why nobody came back. `provider_skipped` means the
  // provider declined to buy the reveal (no credit spent); every other reason
  // comes after a bought reveal. `no_email` = the reveal carried no address.
  reason?: RevealBlockReason | "no_email" | CrmRevealReason;
  // not_deliverable: the verification verdict (catch_all, unknown, invalid, risky).
  verdict?: string;
  // provider_skipped: the provider's own reason (e.g. catch_all_domain).
  detail?: string;
  replayed: boolean;
}

/**
 * The billed reveal of an offered candidate, recorded as served exactly as
 * serve-next records it. Claimed before the spend, so a concurrent or repeated
 * call never pays twice: a decided reveal replays its stored answer.
 */
export async function revealCandidate(
  audienceIn: AudienceRow,
  identityIn: Identity,
  candidateId: string,
  basis: string | null
): Promise<RevealCandidateResult> {
  const existing = await loadCandidate(identityIn.orgId, audienceIn.id, candidateId);
  if (existing.crmContact) return revealCrmCandidateRow(audienceIn, identityIn, existing, basis);
  // A candidate a source offered is revealed and recorded as that source's.
  const source = existing.sourceId
    ? ((await sourcesOf([audienceIn.id])).get(audienceIn.id) ?? []).find((s) => s.id === existing.sourceId) ?? null
    : null;
  const audienceView = source ? sourceView(audienceIn, source) : audienceIn;
  assertCandidateProvider(audienceView, identityIn);
  const identity = apolloIdentity(audienceView, {
    ...identityIn,
    ...(existing.sourceId ? { audienceSourceId: existing.sourceId } : {}),
  });
  if (existing.status === "revealed") {
    return { ...storedReveal(existing.revealResult), replayed: true };
  }
  if (existing.status === "declined") {
    throw new CandidateStateError("Candidate was declined", existing.status);
  }

  const claimCutoff = new Date(Date.now() - CANDIDATE_REVEAL_CLAIM_TTL_MS);
  const [claimed] = await db
    .update(audienceCandidates)
    .set({ status: "revealing", decidedAt: new Date(), basis })
    .where(
      and(
        eq(audienceCandidates.id, candidateId),
        or(
          eq(audienceCandidates.status, "offered"),
          and(eq(audienceCandidates.status, "revealing"), lt(audienceCandidates.decidedAt, claimCutoff))
        )
      )
    )
    .returning();
  if (!claimed) {
    const now = await loadCandidate(identity.orgId, audienceIn.id, candidateId);
    if (now.status === "revealed") {
      return { ...storedReveal(now.revealResult), replayed: true };
    }
    throw new CandidateStateError(`Candidate is ${now.status}`, now.status);
  }

  let result: Omit<RevealCandidateResult, "replayed">;
  const rereach = await rereachOfCandidate(candidateId);
  try {
    result = rereach
      ? await revealRereach(audienceIn, identity, rereach)
      : await revealFresh(audienceIn, identity, claimed.providerPersonId);
    if (result.status === "served" && existing.sourceId) await markSourceServed(existing.sourceId);
  } catch (err) {
    await releaseFailedReveal(identity.orgId, audienceIn.id, claimed, err);
    throw err;
  }
  await db
    .update(audienceCandidates)
    .set({ status: "revealed", revealResult: result })
    .where(eq(audienceCandidates.id, candidateId));
  console.log(
    `[human-service] audience.candidate_revealed org=${identity.orgId} audience=${audienceIn.id} candidate=${candidateId} status=${result.status}${result.reason ? ` reason=${result.reason}` : ""}`
  );
  return { ...result, replayed: false };
}

// A CRM candidate's reveal: the same claim / store / replay as the apollo one,
// the work done by crm-candidates.ts. A lookup still pending hands the candidate
// back (offered), so a later call asks the finder again (for free).
async function revealCrmCandidateRow(
  audience: AudienceRow,
  identity: Identity,
  existing: AudienceCandidate,
  basis: string | null
): Promise<RevealCandidateResult> {
  if (existing.status === "revealed") return { ...storedReveal(existing.revealResult), replayed: true };
  if (existing.status === "declined") throw new CandidateStateError("Candidate was declined", existing.status);
  const claimCutoff = new Date(Date.now() - CANDIDATE_REVEAL_CLAIM_TTL_MS);
  const [claimed] = await db
    .update(audienceCandidates)
    .set({ status: "revealing", decidedAt: new Date(), basis })
    .where(
      and(
        eq(audienceCandidates.id, existing.id),
        or(
          eq(audienceCandidates.status, "offered"),
          and(eq(audienceCandidates.status, "revealing"), lt(audienceCandidates.decidedAt, claimCutoff))
        )
      )
    )
    .returning();
  if (!claimed) {
    const now = await loadCandidate(identity.orgId, audience.id, existing.id);
    if (now.status === "revealed") return { ...storedReveal(now.revealResult), replayed: true };
    throw new CandidateStateError(`Candidate is ${now.status}`, now.status);
  }
  const handBack = () =>
    db
      .update(audienceCandidates)
      .set({ status: "offered", decidedAt: null, basis: null })
      .where(and(eq(audienceCandidates.id, existing.id), eq(audienceCandidates.status, "revealing")));
  let crm: Awaited<ReturnType<typeof revealCrmCandidate>>;
  try {
    crm = await revealCrmCandidate(audience, identity, claimed);
  } catch (err) {
    await releaseFailedReveal(identity.orgId, audience.id, claimed, err);
    throw err;
  }
  const { handBack: back, ...result } = crm;
  if (back) {
    await handBack();
    return { ...result, replayed: false };
  }
  await db
    .update(audienceCandidates)
    .set({ status: "revealed", revealResult: result })
    .where(eq(audienceCandidates.id, existing.id));
  console.log(
    `[human-service] audience.candidate_revealed org=${identity.orgId} audience=${audience.id} candidate=${existing.id} status=${result.status}${result.reason ? ` reason=${result.reason}` : ""} path=crm`
  );
  return { ...result, replayed: false };
}

// A reveal that threw. An outage (a provider, a gate's source) hands the
// candidate back, re-offered at the BACK of the queue (offered_at = now), so a
// retry reveals it once the source answers and the audience keeps moving
// meanwhile. A failure in our OWN data (a constraint or data error: SQLSTATE
// class 22 / 23) would fail the same way on every retry, so the candidate is
// closed exactly like a decline (reason `reveal_failed: <driver reason>`): never
// offered again, the next one comes. DOCDINNERS-REVEAL-HANG-1027: one candidate
// failing on a unique email was handed back at the head of its audience for 30 h.
async function releaseFailedReveal(
  orgId: string,
  audienceId: string,
  candidate: AudienceCandidate,
  err: unknown
): Promise<void> {
  if (/^2[23][0-9A-Z]{3}$/.test(pgErrorCode(err) ?? "")) {
    const reason = `reveal_failed: ${errorMessage(err)}`.slice(0, 500);
    await db.transaction(async (tx) => {
      await tx
        .update(audienceCandidates)
        .set({ status: "declined", declineReason: reason, decidedAt: new Date() })
        .where(and(eq(audienceCandidates.id, candidate.id), eq(audienceCandidates.status, "revealing")));
      await tx
        .insert(audienceScreenedOut)
        .values({
          orgId,
          audienceId,
          providerPersonId: candidate.providerPersonId,
          linkedinUrl: candidate.linkedinUrl,
          reason: `declined: ${reason}`,
        })
        .onConflictDoNothing({
          target: [audienceScreenedOut.audienceId, audienceScreenedOut.providerPersonId],
        });
    });
    console.error(
      `[human-service] audience.candidate_reveal_failed org=${orgId} audience=${audienceId} candidate=${candidate.id} closed=true reason=${errorMessage(err)}`
    );
    return;
  }
  await db
    .update(audienceCandidates)
    .set({ status: "offered", offeredAt: new Date(), decidedAt: null, basis: null })
    .where(and(eq(audienceCandidates.id, candidate.id), eq(audienceCandidates.status, "revealing")));
  console.error(
    `[human-service] audience.candidate_reveal_failed org=${orgId} audience=${audienceId} candidate=${candidate.id} closed=false reason=${errorMessage(err)}`
  );
}

// The billed reveal of a fresh candidate, recorded as served exactly as
// serve-next records it.
async function revealFresh(
  audience: AudienceRow,
  identity: Identity,
  providerPersonId: string
): Promise<Omit<RevealCandidateResult, "replayed">> {
  const revealed = await resolveEmail({
    provider: "apollo",
    providerPersonId: providerPersonId,
    audienceId: audience.id,
    identity,
  });
  if (revealed.person && hasUsableEmail(revealed.person)) {
    const served = await servedWithPersonId(
      identity.orgId,
      audience.id,
      revealed.person,
      revealed.emailVerdict ?? null,
      identity.audienceSourceId ?? null
    );
    return {
      status: "served",
      person: served.person,
      personId: served.personId,
      emailVerdict: served.emailVerdict ?? null,
    };
  } else if (revealed.person) {
    return { status: "not_served", person: null, reason: "no_email" };
  } else {
    // person null ⟹ resolveEmail always names why; "no_person" is what a
    // null person literally is.
    const block = revealed.blocked;
    return {
      status: "not_served",
      person: null,
      reason: block?.reason ?? "no_person",
      ...(block?.verdict ? { verdict: block.verdict } : {}),
      ...(block?.detail ? { detail: block.detail } : {}),
    };
  }
}

// A stored reveal, replayed. Before acceptedEmails existed only a `valid`
// address was ever served on this path (the provider's `deliverable`), so a
// stored served answer without a verdict IS a valid one.
function storedReveal(stored: unknown): Omit<RevealCandidateResult, "replayed"> {
  const r = stored as Omit<RevealCandidateResult, "replayed">;
  if (r.status === "served" && r.emailVerdict === undefined) return { ...r, emailVerdict: "valid" };
  return r;
}

// The "reveal" of a re-offered catch-all person: nothing is bought, the
// address and its verdict are the ones already paid for. Handed only to a
// caller asking for catch-all; a valid-only reveal gives the person back
// (re-reachable later) and answers exactly what the paid reveal answered.
async function revealRereach(
  audience: AudienceRow,
  identity: Identity,
  rereach: NonNullable<Awaited<ReturnType<typeof rereachOfCandidate>>>
): Promise<Omit<RevealCandidateResult, "replayed">> {
  if (!widenedVerdicts(identity.acceptedEmails).includes(rereach.verdict)) {
    await releaseRereach(identity.orgId, audience.brandId, rereach.emailNorm);
    return { status: "not_served", person: null, reason: "not_deliverable", verdict: rereach.verdict };
  }
  const person = rereachPerson(rereach);
  const block = await rereachBlock(identity, audience.brandId, person);
  if (block) {
    await markRereach(identity.orgId, audience.brandId, rereach.emailNorm, "blocked", block);
    return { status: "not_served", person: null, reason: block };
  }
  await recordRereachHandout(identity.orgId, audience.brandId, rereach);
  const served = await servedWithPersonId(identity.orgId, audience.id, person, rereach.verdict);
  console.log(
    `[human-service] catch_all_rereach.handed org=${identity.orgId} audience=${audience.id} leadServe=${rereach.leadServeId} path=candidates`
  );
  return { status: "served", person: served.person, personId: served.personId, emailVerdict: rereach.verdict };
}

/**
 * The caller declines an offered candidate. Written to the same exclusion set
 * the screen writes (`audience_screened_out`), in one transaction with the
 * decision: never offered or served again for this audience, and the pool
 * shrinks by one. Idempotent.
 */
export async function declineCandidate(
  audience: AudienceRow,
  orgId: string,
  candidateId: string,
  reason: string,
  basis: string | null
): Promise<{ declined: true; replayed: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(audienceCandidates)
      .where(
        and(
          eq(audienceCandidates.id, candidateId),
          eq(audienceCandidates.audienceId, audience.id),
          eq(audienceCandidates.orgId, orgId)
        )
      )
      .for("update");
    if (!row) throw new CandidateNotFoundError("Candidate not found");
    if (row.status === "declined") return { declined: true as const, replayed: true };
    if (row.status !== "offered") {
      throw new CandidateStateError(`Candidate is ${row.status}`, row.status);
    }
    await tx
      .update(audienceCandidates)
      .set({ status: "declined", declineReason: reason, basis, decidedAt: new Date() })
      .where(eq(audienceCandidates.id, candidateId));
    await tx
      .insert(audienceScreenedOut)
      .values({
        orgId,
        audienceId: audience.id,
        providerPersonId: row.providerPersonId,
        linkedinUrl: row.linkedinUrl,
        reason: `declined: ${reason}`,
      })
      .onConflictDoNothing({
        target: [audienceScreenedOut.audienceId, audienceScreenedOut.providerPersonId],
      });
    console.log(
      `[human-service] audience.candidate_declined org=${orgId} audience=${audience.id} candidate=${candidateId}`
    );
    return { declined: true as const, replayed: false };
  }).then(async (r) => {
    if (!r.replayed) await markRereachOfCandidate(candidateId, "declined");
    return r;
  });
}

// --- Past screen verdicts (bronze), for lead-service's history ---------------

export const SCREENINGS_MAX_LIMIT = 1000;

export interface ScreeningsPage {
  screenings: Array<{
    id: string;
    providerPersonId: string;
    linkedinUrl: string | null;
    teaser: TeaserSnapshot;
    verdict: boolean;
    yesProbability: number | null;
    targetText: string | null;
    targetField: string | null;
    reason: string | null;
    model: string;
    promptVersion: string;
    createdAt: string;
  }>;
  total: number;
  limit: number;
  offset: number;
}

/**
 * Every screen verdict of an audience, OLDEST first. Bronze is append-only, so
 * an offset into the oldest-first order is stable while new verdicts land.
 */
export async function listScreenings(args: {
  orgId: string;
  audienceId: string;
  limit: number;
  offset: number;
  providerPersonId?: string;
}): Promise<ScreeningsPage> {
  const t = audienceTeaserScreenings;
  const where = and(
    eq(t.orgId, args.orgId),
    eq(t.audienceId, args.audienceId),
    args.providerPersonId ? eq(t.providerPersonId, args.providerPersonId) : undefined
  );
  const [counted] = await db.select({ total: sql<number>`count(*)` }).from(t).where(where);
  const rows = await db
    .select()
    .from(t)
    .where(where)
    .orderBy(asc(t.createdAt), asc(t.id))
    .limit(args.limit)
    .offset(args.offset);
  return {
    screenings: rows.map((r) => ({
      id: r.id,
      providerPersonId: r.providerPersonId,
      linkedinUrl: r.linkedinUrl,
      teaser: r.teaser,
      verdict: r.verdict,
      yesProbability: r.yesProbability,
      targetText: r.targetText,
      targetField: r.targetField,
      reason: r.reason,
      model: r.model,
      promptVersion: r.promptVersion,
      createdAt: r.createdAt.toISOString(),
    })),
    total: Number(counted?.total ?? 0),
    limit: args.limit,
    offset: args.offset,
  };
}
