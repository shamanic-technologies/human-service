// PROFILE x SOURCE (owner 2026-10-09).
//
// A client PROFILE says WHO ("Heads of QA"): it is a cold audience (an Apollo
// search list, `apollo_search`) the client keeps, pauses or archives on the
// Targeting page. A SOURCE says WHERE we find them: a buying signal (hiring now,
// new in role, recently funded) or competitor-post engagement. The two are
// orthogonal, so the lists a source serves are one audience per (profile, source):
// "Heads of QA (Recently funded)". Each carries `profile_audience_id` and screens
// its candidates against the profile's own text, so pausing "CTOs" stops every
// list that finds CTOs, whatever the source.
//
// Before this, each signal list carried the WHOLE launch ICP ("VPs of Engineering,
// Heads of QA, and CTOs ..."), so a paused profile kept being sourced through every
// signal (brand d0965c2c, 2026-10-09). Those whole-ICP lists (profile NULL) are
// RETIRED (archived, history kept) by the first profile build of their offer.
//
// Smallest delta of the existing model: an audience stays immutable (stats keyed
// by its id), a source list is a plain apollo pointer audience exactly as before,
// only built on the profile's Apollo audience instead of the ICP's.
//
// Live = profile live AND source on AND list status. Two hold tables keep the two
// switches independent: `source_campaign_audience_holds` (a source campaign OFF)
// and `audience_profile_holds` (a person paused the profile). A list resumes only
// when NEITHER holds it. A person changing a list or a profile directly wins over
// both: their own row's open holds are closed.
//
// Cost: building a source list spends nothing new. The coverage read and the
// signal list's size are free Apollo teaser searches (apollo-service); the
// profile's Apollo audience is the one serve-next would build anyway; the profile
// text is drafted once (chat-service, org-billed) if it was not written yet.

import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  audienceProfileHolds,
  audiences,
  sourceCampaignAudienceHolds,
  sourceCampaignStates,
} from "../db/schema.js";
import {
  BUYING_SIGNAL_TYPES,
  createApolloSignalAudience,
  isLinkedinEngagementFilters,
  measureSignalCoverage,
  type BuyingSignalType,
  type SignalCoverage,
} from "../lib/apollo-audiences.js";
import { audienceListKind } from "./audience-snapshot.js";
import { ensureTargetText, audienceTargetFields } from "./audience-target-text.js";
import { dedupeSegmentNames } from "./audience-refill.js";
import { ensureApolloPointer } from "./audiences.js";
import type { Identity } from "./people-providers.js";

type AudienceRow = typeof audiences.$inferSelect;

export const PROFILE_SIGNAL_SOURCE = "icp_portfolio_signal";

/** Owner threshold (2026-10-03): distinct companies a signal must reach, per profile. */
export const SIGNAL_MIN_COMPANIES = 20;

/**
 * Recency window per signal. A job posting goes stale fast (the hiring push is
 * now or never), so 30 days. A new-in-role person keeps rebuilding their stack
 * for about their first quarter, and a funded company spends the round over
 * months, so 90 days for both. Hiring is measured for ANY role: the profile
 * names who we write to, not which roles their company hires.
 */
export const SIGNAL_WINDOW_DAYS: Record<BuyingSignalType, number> = {
  hiring: 30,
  job_change: 90,
  funding: 90,
};

export const SIGNAL_NAMES: Record<BuyingSignalType, string> = {
  hiring: "Hiring now",
  job_change: "New in role",
  funding: "Recently funded",
};

/** A source list's source: a buying-signal type, or competitor-post engagement. */
export type SourceKey = BuyingSignalType | "linkedin_engagement";

export function sourceKeyOf(row: Pick<AudienceRow, "filters">): SourceKey | null {
  if (isLinkedinEngagementFilters(row.filters)) return "linkedin_engagement";
  const f = row.filters as Record<string, unknown> | null;
  const s = f?.buying_signal as Record<string, unknown> | undefined;
  const type = s && typeof s === "object" ? s.type : undefined;
  return BUYING_SIGNAL_TYPES.includes(type as BuyingSignalType) ? (type as BuyingSignalType) : null;
}

/** A client profile: a cold Apollo search audience that is not itself a source list. */
export function isProfile(row: AudienceRow): boolean {
  return (
    row.provider === "apollo" &&
    !row.profileAudienceId &&
    row.status !== "deprecated" &&
    audienceListKind(row) === "apollo_search"
  );
}

export interface OfferScope {
  orgId: string;
  brandId: string;
  offerId: string;
}

async function offerRows(scope: OfferScope): Promise<AudienceRow[]> {
  return db
    .select()
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, scope.orgId),
        eq(audiences.brandId, scope.brandId),
        eq(audiences.offerId, scope.offerId),
        notInArray(audiences.status, ["deprecated"])
      )
    )
    .orderBy(audiences.createdAt);
}

async function openSourceHolds(ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(sourceCampaignAudienceHolds)
    .where(and(inArray(sourceCampaignAudienceHolds.audienceId, ids), isNull(sourceCampaignAudienceHolds.releasedAt)));
}

/** Ids among `ids` a person's profile pause still holds. */
export async function profileHeldIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ audienceId: audienceProfileHolds.audienceId })
    .from(audienceProfileHolds)
    .where(and(inArray(audienceProfileHolds.audienceId, ids), isNull(audienceProfileHolds.releasedAt)));
  return new Set(rows.map((r) => r.audienceId));
}

/**
 * The offer's profiles whose people are wanted: active, or paused ONLY because the
 * Apollo Cold Filters source is off (a source campaign hold, not a person). Turning a
 * source off is not unwanting the profile, so its other sources keep it.
 */
export async function liveProfiles(scope: OfferScope, rows?: AudienceRow[]): Promise<AudienceRow[]> {
  const all = rows ?? (await offerRows(scope));
  const profiles = all.filter(isProfile);
  const paused = profiles.filter((p) => p.status === "paused").map((p) => p.id);
  const sourceHeld = new Set((await openSourceHolds(paused)).map((h) => h.audienceId));
  return profiles.filter((p) => p.status === "active" || (p.status === "paused" && sourceHeld.has(p.id)));
}

/**
 * True when a live profile of the offer still lacks its list of that source (any
 * status counts as having it: a list a person archived is never re-created). For
 * buying signals, a pair below threshold has no list, so it is re-measured (free).
 */
export async function profileListsDue(
  scope: OfferScope,
  list: "apollo_buying_signal" | "linkedin_engagement"
): Promise<boolean> {
  const rows = await offerRows(scope);
  const profiles = await liveProfiles(scope, rows);
  const keys: SourceKey[] = list === "linkedin_engagement" ? ["linkedin_engagement"] : [...BUYING_SIGNAL_TYPES];
  return profiles.some((p) => {
    const have = new Set(rows.filter((r) => r.profileAudienceId === p.id).map((r) => sourceKeyOf(r)));
    return keys.some((k) => !have.has(k));
  });
}

// ── Born status of a new source list ─────────────────────────────────────────

export interface BornStatus {
  status: "active" | "paused";
  /** Born paused by a source campaign OFF: held so its ON resumes it. */
  sourceHold: { originSlug: string; campaignId: string | null } | null;
}

/**
 * The status a new (profile, source) list is born in, from what already decides it:
 *   1. the offer's source campaign for that origin (ON: active, OFF: paused + held);
 *   2. else the retired whole-ICP list of that source, if still there (its status, and
 *      its source hold), so a list a person paused stays paused per profile;
 *   3. else the sibling lists of that source (active when any is);
 *   4. else the source's own default (`fallback`).
 */
export async function bornStatus(
  scope: OfferScope,
  key: SourceKey,
  originSlug: string | null,
  rows: AudienceRow[],
  fallback: "active" | "paused"
): Promise<BornStatus> {
  if (originSlug) {
    const [state] = await db
      .select()
      .from(sourceCampaignStates)
      .where(
        and(
          eq(sourceCampaignStates.orgId, scope.orgId),
          eq(sourceCampaignStates.brandId, scope.brandId),
          eq(sourceCampaignStates.offerId, scope.offerId),
          eq(sourceCampaignStates.originSlug, originSlug)
        )
      );
    if (state) {
      return state.status === "on"
        ? { status: "active", sourceHold: null }
        : { status: "paused", sourceHold: { originSlug, campaignId: state.campaignId } };
    }
  }
  const sameSource = rows.filter((r) => sourceKeyOf(r) === key && r.status !== "archived");
  const legacy = sameSource.find((r) => !r.profileAudienceId);
  if (legacy) {
    if (legacy.status === "active") return { status: "active", sourceHold: null };
    const [hold] = await openSourceHolds([legacy.id]);
    return {
      status: "paused",
      sourceHold: hold ? { originSlug: hold.originSlug, campaignId: hold.campaignId } : null,
    };
  }
  const siblings = sameSource.filter((r) => r.profileAudienceId);
  if (siblings.length > 0) {
    return { status: siblings.some((r) => r.status === "active") ? "active" : "paused", sourceHold: null };
  }
  return { status: fallback, sourceHold: null };
}

/** Record the source hold a list was born under (born paused by a source campaign OFF). */
export async function holdBornList(scope: OfferScope, audienceId: string, born: BornStatus): Promise<void> {
  if (!born.sourceHold) return;
  await db
    .insert(sourceCampaignAudienceHolds)
    .values({
      ...scope,
      originSlug: born.sourceHold.originSlug,
      audienceId,
      campaignId: born.sourceHold.campaignId,
    })
    .onConflictDoNothing();
}

/**
 * Retire the offer's whole-ICP lists of one source (built before profiles: they
 * reach every profile, paused ones included). Archived, never deleted: their stats
 * and memberships stay. Called once every live profile of the offer has its answer.
 */
export async function retireWholeIcpLists(scope: OfferScope, key: SourceKey): Promise<string[]> {
  const rows = (await offerRows(scope)).filter(
    (r) => !r.profileAudienceId && sourceKeyOf(r) === key && ["active", "paused", "suggested"].includes(r.status)
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await db.update(audiences).set({ status: "archived", updatedAt: new Date() }).where(inArray(audiences.id, ids));
  console.log(
    `[human-service] profile_sources.whole_icp_retired org=${scope.orgId} brand=${scope.brandId} offer=${scope.offerId} source=${key} audiences=${ids.join(",")}`
  );
  return ids;
}

/** The profile with its Apollo audience and its own text, built if missing. */
export async function readyProfile(
  profile: AudienceRow,
  identity: Identity
): Promise<{ row: AudienceRow; text: string }> {
  // The profile's own builds open their own runs, labelled as the profile's (Apollo
  // search) work, never as the source list being built on top of it.
  const own = { orgId: profile.orgId, userId: identity.userId };
  const built = await ensureApolloPointer(profile, own);
  if (!built.apolloAudienceId) {
    throw new Error(`profile ${profile.id} has no Apollo audience to build its source lists on`);
  }
  const text = await ensureTargetText(built, own);
  if (!text) throw new Error(`profile ${profile.id} has no text to screen its source lists against`);
  return { row: built, text };
}

export function profileListName(profile: Pick<AudienceRow, "name">, source: string): string {
  return `${profile.name} (${source})`;
}

// ── Buying-signal lists per profile ──────────────────────────────────────────

export interface ProfileSignalOutcome {
  profileAudienceId: string;
  profileName: string;
  type: BuyingSignalType;
  windowDays: number;
  outcome: "created" | "exists" | "below_threshold" | "failed";
  /** Verified-email people the signal reaches for the profile. Null when unmeasured. */
  people: number | null;
  /** Distinct companies of those people. Null when unmeasured. */
  companies: number | null;
  companiesExact: boolean | null;
  audienceId: string | null;
  reason: string | null;
}

export interface EnsureProfileSignalsArgs extends OfferScope {
  userId: string;
  /** Carries the buying-signal sourcing origin (and a run). */
  identity: Identity;
  /** The buying-signal origin slug (born status from its source campaign). */
  originSlug: string | null;
  /** Force the born status (a source campaign turning ON). */
  status?: "active" | "paused";
}

const signalsInFlight = new Map<string, Promise<ProfileSignalOutcome[]>>();

/**
 * Every live profile of the offer gets one list per buying signal reaching
 * SIGNAL_MIN_COMPANIES companies for THAT profile. Existing lists (any status: a
 * list a person archived is never re-created) are kept. Once every profile has its
 * answer without a failure, the offer's whole-ICP signal lists are retired.
 * Never throws: a failure is that pair's `failed` outcome, logged loud.
 */
export function ensureProfileSignalLists(args: EnsureProfileSignalsArgs): Promise<ProfileSignalOutcome[]> {
  const key = `${args.orgId}:${args.brandId}:${args.offerId}`;
  const running = signalsInFlight.get(key);
  if (running) return running;
  const p = ensureSignalsOnce(args).finally(() => signalsInFlight.delete(key));
  signalsInFlight.set(key, p);
  return p;
}

async function ensureSignalsOnce(args: EnsureProfileSignalsArgs): Promise<ProfileSignalOutcome[]> {
  const scope = { orgId: args.orgId, brandId: args.brandId, offerId: args.offerId };
  const rows = await offerRows(scope);
  const profiles = await liveProfiles(scope, rows);
  const outcomes: ProfileSignalOutcome[] = [];
  for (const profile of profiles) {
    outcomes.push(...(await ensureSignalsForProfile(profile, rows, args)));
  }
  if (profiles.length > 0 && !outcomes.some((o) => o.outcome === "failed")) {
    for (const type of BUYING_SIGNAL_TYPES) await retireWholeIcpLists(scope, type);
  }
  console.log(
    `[human-service] profile_sources.signals org=${args.orgId} brand=${args.brandId} offer=${args.offerId} profiles=${profiles.length} ${outcomes
      .map((o) => `${o.profileAudienceId.slice(0, 8)}/${o.type}:${o.outcome}${o.companies !== null ? `(${o.companies}co)` : ""}`)
      .join(",")}`
  );
  return outcomes;
}

async function ensureSignalsForProfile(
  profile: AudienceRow,
  rows: AudienceRow[],
  args: EnsureProfileSignalsArgs
): Promise<ProfileSignalOutcome[]> {
  const scope = { orgId: args.orgId, brandId: args.brandId, offerId: args.offerId };
  const base = (type: BuyingSignalType) => ({
    profileAudienceId: profile.id,
    profileName: profile.name,
    type,
    windowDays: SIGNAL_WINDOW_DAYS[type],
    people: null,
    companies: null,
    companiesExact: null,
    audienceId: null,
    reason: null,
  });
  const failAll = (types: BuyingSignalType[], reason: string): ProfileSignalOutcome[] => {
    console.error(
      `[human-service] profile_sources.signals_failed org=${args.orgId} brand=${args.brandId} profile=${profile.id} reason=${JSON.stringify(reason)}`
    );
    return types.map((t) => ({ ...base(t), outcome: "failed", reason }));
  };

  const existing = new Map<BuyingSignalType, AudienceRow>();
  for (const r of rows) {
    const k = r.profileAudienceId === profile.id ? sourceKeyOf(r) : null;
    if (k && k !== "linkedin_engagement" && !existing.has(k)) existing.set(k, r);
  }
  const done: ProfileSignalOutcome[] = [...existing].map(([type, r]) => ({ ...base(type), outcome: "exists", audienceId: r.id }));
  const missing = BUYING_SIGNAL_TYPES.filter((t) => !existing.has(t));
  if (missing.length === 0) return done;

  let ready: { row: AudienceRow; text: string };
  let coverage: SignalCoverage[];
  try {
    ready = await readyProfile(profile, args.identity);
    const windows = [...new Set(Object.values(SIGNAL_WINDOW_DAYS))].sort((a, b) => a - b);
    coverage = (
      await measureSignalCoverage({ apolloAudienceId: ready.row.apolloAudienceId!, windowDays: windows, identity: args.identity })
    ).signals;
  } catch (err) {
    return [...done, ...failAll(missing, errMessage(err))];
  }

  for (const type of missing) {
    const windowDays = SIGNAL_WINDOW_DAYS[type];
    const measured = coverage.find((c) => c.type === type && c.windowDays === windowDays);
    if (!measured) {
      done.push(...failAll([type], "apollo-service returned no coverage for this signal"));
      continue;
    }
    const common = { ...base(type), people: measured.count, companies: measured.companies, companiesExact: measured.companiesExact };
    if (measured.companies < SIGNAL_MIN_COMPANIES) {
      done.push({ ...common, outcome: "below_threshold", reason: `${measured.companies} companies < ${SIGNAL_MIN_COMPANIES}` });
      continue;
    }
    try {
      const row = await createSignalList({ scope, profile: ready.row, text: ready.text, type, windowDays, rows, args });
      rows.push(row);
      done.push({ ...common, outcome: "created", audienceId: row.id });
    } catch (err) {
      const [failed] = failAll([type], errMessage(err));
      done.push({ ...failed, people: common.people, companies: common.companies, companiesExact: common.companiesExact });
    }
  }
  return done;
}

function signalDescription(profileName: string, type: BuyingSignalType, windowDays: number): string {
  const what =
    type === "hiring"
      ? "whose company posted a job opening"
      : type === "job_change"
        ? "who started their current role"
        : "whose company raised its latest funding round";
  return `${profileName} ${what} in the last ${windowDays} days.`;
}

async function createSignalList(input: {
  scope: OfferScope;
  profile: AudienceRow;
  text: string;
  type: BuyingSignalType;
  windowDays: number;
  rows: AudienceRow[];
  args: EnsureProfileSignalsArgs;
}): Promise<AudienceRow> {
  const { scope, profile, type, windowDays, args } = input;
  const [name] = dedupeSegmentNames([profileListName(profile, SIGNAL_NAMES[type])], input.rows.map((r) => r.name));
  const born: BornStatus = args.status
    ? { status: args.status, sourceHold: null }
    : await bornStatus(scope, type, args.originSlug, input.rows, "active");
  const apollo = await createApolloSignalAudience({
    baseApolloAudienceId: profile.apolloAudienceId!,
    brandId: scope.brandId,
    name,
    type,
    windowDays,
    identity: args.identity,
  });
  const [row] = await db
    .insert(audiences)
    .values({
      ...scope,
      name,
      description: signalDescription(profile.name, type, windowDays),
      // The profile's own text: the screen judges this list's people against WHO
      // the profile is, never the whole launch ICP.
      nlPrompt: input.text,
      ...audienceTargetFields(input.text),
      provider: "apollo",
      apolloAudienceId: apollo.apolloAudienceId,
      filters: apollo.filters,
      apolloCount: apollo.count,
      countedAt: new Date(),
      status: born.status,
      source: PROFILE_SIGNAL_SOURCE,
      profileAudienceId: profile.id,
      createdByUserId: args.userId,
    })
    .returning();
  await holdBornList(scope, row.id, born);
  console.log(
    `[human-service] profile_sources.signal_created org=${scope.orgId} brand=${scope.brandId} profile=${profile.id} type=${type} audience=${row.id} status=${born.status} count=${apollo.count}`
  );
  return row;
}

// ── A person changes a profile (or a list) ───────────────────────────────────

/**
 * A person set this audience's status (PATCH /orgs/audiences/{id}/status). Their
 * action wins over both automatic switches: the row's own open holds are closed, so
 * no source campaign ON nor profile resume flips it back. Then, when the row is a
 * profile, its source lists follow:
 *   - not active: every list still running (or held by a source campaign) is held by
 *     the profile, and the running ones are paused;
 *   - active: the lists the profile held are released, and resumed unless a source
 *     campaign OFF still holds them.
 * Archived / deprecated lists are never touched.
 */
export async function applyPersonStatusChange(row: AudienceRow): Promise<{ paused: string[]; resumed: string[] }> {
  const now = new Date();
  await db
    .update(sourceCampaignAudienceHolds)
    .set({ releasedAt: now })
    .where(and(eq(sourceCampaignAudienceHolds.audienceId, row.id), isNull(sourceCampaignAudienceHolds.releasedAt)));
  await db
    .update(audienceProfileHolds)
    .set({ releasedAt: now })
    .where(and(eq(audienceProfileHolds.audienceId, row.id), isNull(audienceProfileHolds.releasedAt)));

  const lists = await db
    .select()
    .from(audiences)
    .where(and(eq(audiences.profileAudienceId, row.id), notInArray(audiences.status, ["archived", "deprecated"])));
  if (lists.length === 0) return { paused: [], resumed: [] };

  if (row.status !== "active") {
    const sourceHeld = new Set((await openSourceHolds(lists.map((l) => l.id))).map((h) => h.audienceId));
    const toHold = lists.filter((l) => l.status === "active" || sourceHeld.has(l.id));
    const running = toHold.filter((l) => l.status === "active").map((l) => l.id);
    if (toHold.length > 0) {
      await db.transaction(async (tx) => {
        await tx
          .insert(audienceProfileHolds)
          .values(toHold.map((l) => ({ orgId: l.orgId, brandId: l.brandId, profileAudienceId: row.id, audienceId: l.id })))
          .onConflictDoNothing();
        if (running.length > 0) {
          await tx
            .update(audiences)
            .set({ status: "paused", updatedAt: now })
            .where(and(inArray(audiences.id, running), eq(audiences.status, "active")));
        }
      });
    }
    console.log(
      `[human-service] profile_sources.profile_paused org=${row.orgId} profile=${row.id} status=${row.status} held=${toHold.length} paused=${running.join(",") || "-"}`
    );
    return { paused: running, resumed: [] };
  }

  const released = await db
    .update(audienceProfileHolds)
    .set({ releasedAt: now })
    .where(and(eq(audienceProfileHolds.profileAudienceId, row.id), isNull(audienceProfileHolds.releasedAt)))
    .returning({ audienceId: audienceProfileHolds.audienceId });
  const releasedIds = released.map((r) => r.audienceId);
  const sourceHeld = new Set((await openSourceHolds(releasedIds)).map((h) => h.audienceId));
  const resumable = releasedIds.filter((id) => !sourceHeld.has(id));
  let resumed: string[] = [];
  if (resumable.length > 0) {
    resumed = (
      await db
        .update(audiences)
        .set({ status: "active", updatedAt: now })
        .where(and(inArray(audiences.id, resumable), eq(audiences.status, "paused")))
        .returning({ id: audiences.id })
    ).map((r) => r.id);
  }
  console.log(
    `[human-service] profile_sources.profile_resumed org=${row.orgId} profile=${row.id} released=${releasedIds.length} resumed=${resumed.join(",") || "-"}`
  );
  return { paused: [], resumed };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
