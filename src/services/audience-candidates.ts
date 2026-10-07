// Candidate API — the pre-pay frontier handed to lead-service.
//
// WHY. Owner decision 2026-10-07: human-service owns WHO a person is; lead-service
// owns whether a lead MEETS a business condition (the client's criteria AND the
// "does this person belong to the audience" screen, which is qualification). So
// lead-service must see a candidate — who it is and its company — BEFORE the
// paid reveal, and decide. serve-next used to do teaser + screen + reveal in one
// call, which left the caller no moment to look or to decline.
//
// THE FLOW (apollo audiences only — the one provider with a free teaser and a
// separate billed reveal):
//   next    → pop the next buffered free teaser, apply every FREE check
//             serve-next used to apply (brand suppression, opt-outs + won people, the
//             brand's own company, hard bounces, people already rejected for
//             this audience), and hand it out as an `offered` candidate. No
//             screen, no reveal, no spend.
//   reveal  → the billed reveal, recorded as served exactly as serve-next did
//             (finalizeResolved + membership), same `{status, person, personId}`
//             shape. Claimed atomically before the spend: billed once.
//   decline → written to `audience_screened_out`, the SAME exclusion set the
//             screen writes: never buffered or offered again for this audience,
//             and the audience's Size drops by one, exactly like a screen
//             rejection.
//
// This is the ONLY serve path for an apollo audience: since 2026-10-07 serve-next
// answers 422 for one (its own screen was removed), so no apollo lead is ever
// served without the caller's screen.
//
// YIELD. The screen's "this audience has stopped producing people" rule
// (teaser-screening.ts) is re-applied HERE from the declines lead-service sends:
// over the last SCREEN_YIELD_WINDOW decisions under the latest `basis` (the name
// of the question the caller's qualification asks — a new basis starts a new
// window, like a new target text / bar does for the screen), fewer than
// SCREEN_YIELD_MIN_PASSES reveals ⟹ `exhausted`, with the reachable ceiling
// persisted and the refill asked (exhaustOnScreenYield). Computed here, not
// stated by the caller, because the CONSEQUENCES (Remaining, refill) are ours.

import { and, asc, desc, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { db, sql as pg } from "../db/index.js";
import {
  audienceCandidates,
  audienceScreenedOut,
  audienceTeaserScreenings,
  audiences,
  type AudienceCandidate,
  type TeaserSnapshot,
} from "../db/schema.js";
import { filterSuppressed } from "./suppression.js";
import { bufferTeasers, popTeaser, type BufferedTeaser } from "./teaser-buffer.js";
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
import {
  AudienceNotServableError,
  ensureApolloPointer,
  exhaustOnScreenYield,
  hasUsableEmail,
  needsApolloPointerBuild,
  persistReachableCountOnExhaustion,
  servedWithPersonId,
  SERVE_NEXT_BUDGET_MS,
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
      reason: "pool_exhausted" | "yield_exhausted";
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

// Only an apollo audience has a free teaser and a separate billed reveal. crm
// contacts are burned by crm-service on serve and apify bills per hit, so there
// is no free moment to hand out: those keep serve-next.
function assertCandidateProvider(audience: AudienceRow, identity: Identity): void {
  if (
    isCrmSourcedFeature(identity.workflowTracking?.featureSlug) ||
    audience.provider !== "apollo"
  ) {
    throw new AudienceNotServableError(
      "Candidates exist only for apollo audiences (a free teaser, then a billed reveal). Use serve-next for crm / apify."
    );
  }
}

// linkedin_engagement no-repeat lives in apollo-service keyed on x-audience-id:
// stamp THIS audience on the apollo calls (the crm serve-next path does the same).
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
  audienceId: string
): Promise<{ screens: number; passes: number; spent: boolean } | null> {
  const [latest] = await db
    .select({ basis: audienceCandidates.basis })
    .from(audienceCandidates)
    .where(and(eq(audienceCandidates.audienceId, audienceId), isNotNull(audienceCandidates.decidedAt)))
    .orderBy(desc(audienceCandidates.decidedAt))
    .limit(1);
  if (!latest) return null;
  const recent = await db
    .select({ status: audienceCandidates.status })
    .from(audienceCandidates)
    .where(
      and(
        eq(audienceCandidates.audienceId, audienceId),
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
  audienceId: string
): Promise<AudienceCandidate | null> {
  const cutoff = new Date(Date.now() - CANDIDATE_OFFER_TTL_MS);
  const rows = await pg<{ id: string }[]>`
    UPDATE audience_candidates SET offered_at = now()
    WHERE id = (
      SELECT id FROM audience_candidates
      WHERE org_id = ${orgId} AND audience_id = ${audienceId}
        AND status = 'offered' AND offered_at < ${cutoff.toISOString()}::timestamptz
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

// The free checks run at POP time (the screen is the caller's). Each one is
// read live, so a teaser buffered before a person opted out / bounced / was
// served under another audience never reaches the caller.
async function passesFreeChecks(
  audience: AudienceRow,
  identity: Identity,
  teaser: BufferedTeaser,
  exclusions: Awaited<ReturnType<typeof loadServeExclusions>>,
  ownCompany: Awaited<ReturnType<typeof loadOwnCompany>>
): Promise<boolean> {
  const key = { linkedinUrl: teaser.linkedinUrl, providerPersonId: teaser.providerPersonId };
  const [fresh] = await filterSuppressed(identity.orgId, [audience.brandId], [key]);
  if (!fresh) return false;
  if (matchesOptOut(exclusions, key)) {
    console.log(
      `[human-service] opt_out.blocked_candidate org=${identity.orgId} audience=${audience.id} person=${teaser.providerPersonId}`
    );
    return false;
  }
  if (isOwnCompany(ownCompany, { name: teaser.teaser?.organizationName ?? null })) {
    console.log(
      `[human-service] own_company.blocked_candidate org=${identity.orgId} audience=${audience.id} person=${teaser.providerPersonId}`
    );
    return false;
  }
  const [reachable] = await filterBounced(identity, [key]);
  if (!reachable) {
    console.log(
      `[human-service] bounce.blocked_candidate org=${identity.orgId} audience=${audience.id} person=${teaser.providerPersonId}`
    );
    return false;
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
  return !rejected;
}

/**
 * The next candidate of an apollo audience, free: no screen, no reveal. The
 * caller (route) MUST pass identity.brandIds = [audience.brandId].
 */
export async function nextCandidate(
  audienceIn: AudienceRow,
  identityIn: Identity,
  budgetMs: number = SERVE_NEXT_BUDGET_MS
): Promise<NextCandidateResult> {
  const deadline = Date.now() + budgetMs;
  let audience = audienceIn;
  assertCandidateProvider(audience, identityIn);
  if (needsApolloPointerBuild(audience)) {
    audience = await ensureApolloPointer(audience, identityIn);
  }
  const storedFilters = (audience.filters ?? null) as Record<string, unknown> | null;
  if (!storedFilters || Object.keys(storedFilters).length === 0) {
    throw new AudienceNotServableError("Audience has no stored filters — cannot serve people.");
  }
  // The text the caller's screen judges against: written now if a segment's
  // background draft has not landed.
  if (!audience.targetText) {
    audience = { ...audience, targetText: await ensureTargetText(audience, identityIn) };
  }
  const target = screenTarget(audience);
  const identity = apolloIdentity(audience, identityIn);

  const yieldNow = await readCandidateYield(audience.id);
  if (yieldNow?.spent) {
    await exhaustOnScreenYield(identity, audience, yieldNow);
    return { status: "exhausted", candidate: null, reason: "yield_exhausted", target };
  }

  const lapsed = await retakeLapsedOffer(identity.orgId, audience.id);
  if (lapsed) return { status: "candidate", candidate: toView(lapsed), target };

  const exclusions = await loadServeExclusions(identity);
  const ownCompany = await loadOwnCompany(identity.orgId, [audience.brandId]);
  const apolloSearchParams = audience.apolloAudienceId ? storedFilters : undefined;
  const apolloFilters = audience.apolloAudienceId ? {} : (storedFilters as PeopleSearchFilters);

  let walked = 0;
  for (;;) {
    if (walked > 0 && Date.now() >= deadline) {
      console.log(
        `[human-service] audience.candidate_budget_spent org=${identity.orgId} audience=${audience.id} walked=${walked} budgetMs=${budgetMs}`
      );
      return { status: "pending", candidate: null, target };
    }
    walked += 1;
    const teaser = await popTeaser(identity.orgId, audience.id);
    if (!teaser) {
      const search = await peopleSearch({
        provider: "apollo",
        filters: apolloFilters,
        apolloSearchParams,
        audienceId: audience.id,
        identity,
      });
      if (search.people.length === 0) {
        await persistReachableCountOnExhaustion(identity.orgId, audience.id);
        return { status: "exhausted", candidate: null, reason: "pool_exhausted", target };
      }
      await bufferTeasers(identity.orgId, audience.id, search.people);
      continue;
    }
    if (!(await passesFreeChecks(audience, identity, teaser, exclusions, ownCompany))) continue;

    // Once per (audience, person): a person already offered / decided is never
    // handed out twice.
    const [row] = await db
      .insert(audienceCandidates)
      .values({
        orgId: identity.orgId,
        audienceId: audience.id,
        providerPersonId: teaser.providerPersonId,
        linkedinUrl: teaser.linkedinUrl,
        teaser: teaser.teaser,
        organizationDomain: teaser.organizationDomain,
      })
      .onConflictDoNothing({
        target: [audienceCandidates.audienceId, audienceCandidates.providerPersonId],
      })
      .returning();
    if (!row) continue;
    console.log(
      `[human-service] audience.candidate_offered org=${identity.orgId} audience=${audience.id} candidate=${row.id} domain=${row.organizationDomain ? "yes" : "no"}`
    );
    return { status: "candidate", candidate: toView(row), target };
  }
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
  // `served` ⟹ the served person, same shape as serve-next. `not_served` ⟹ the
  // reveal ran (and was billed) but yielded nobody servable: no usable email,
  // not deliverable, or blocked post-pay (suppressed / opted out / won /
  // bounced / own company). Ask for the next candidate.
  status: "served" | "not_served";
  person: Person | null;
  personId?: string;
  // On every `not_served`: why nobody came back. `provider_skipped` means the
  // provider declined to buy the reveal (no credit spent); every other reason
  // comes after a bought reveal. `no_email` = the reveal carried no address.
  reason?: RevealBlockReason | "no_email";
  // not_deliverable: the verification verdict (catch_all, unknown, invalid, risky).
  verdict?: string;
  // provider_skipped: the provider's own reason (e.g. catch_all_domain).
  detail?: string;
  replayed: boolean;
}

/**
 * The billed reveal of an offered candidate, recorded as served
 * (finalizeResolved + membership). Claimed before the spend, so a concurrent or repeated
 * call never pays twice: a decided reveal replays its stored answer.
 */
export async function revealCandidate(
  audienceIn: AudienceRow,
  identityIn: Identity,
  candidateId: string,
  basis: string | null
): Promise<RevealCandidateResult> {
  assertCandidateProvider(audienceIn, identityIn);
  const identity = apolloIdentity(audienceIn, identityIn);
  const existing = await loadCandidate(identity.orgId, audienceIn.id, candidateId);
  if (existing.status === "revealed") {
    return { ...(existing.revealResult as Omit<RevealCandidateResult, "replayed">), replayed: true };
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
      return { ...(now.revealResult as Omit<RevealCandidateResult, "replayed">), replayed: true };
    }
    throw new CandidateStateError(`Candidate is ${now.status}`, now.status);
  }

  let result: Omit<RevealCandidateResult, "replayed">;
  try {
    const revealed = await resolveEmail({
      provider: "apollo",
      providerPersonId: claimed.providerPersonId,
      audienceId: audienceIn.id,
      identity,
    });
    if (revealed.person && hasUsableEmail(revealed.person)) {
      const served = await servedWithPersonId(identity.orgId, audienceIn.id, revealed.person);
      result = { status: "served", person: served.person, personId: served.personId };
    } else if (revealed.person) {
      result = { status: "not_served", person: null, reason: "no_email" };
    } else {
      // person null ⟹ resolveEmail always names why; "no_person" is what a
      // null person literally is.
      const block = revealed.blocked;
      result = {
        status: "not_served",
        person: null,
        reason: block?.reason ?? "no_person",
        ...(block?.verdict ? { verdict: block.verdict } : {}),
        ...(block?.detail ? { detail: block.detail } : {}),
      };
    }
  } catch (err) {
    // Nothing recorded: hand the candidate back so a retry can reveal it.
    await db
      .update(audienceCandidates)
      .set({ status: "offered", decidedAt: null, basis: null })
      .where(and(eq(audienceCandidates.id, candidateId), eq(audienceCandidates.status, "revealing")));
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
