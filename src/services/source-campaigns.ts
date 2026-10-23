// SOURCE CAMPAIGNS: the lead sources of an offer are campaigns (owner 2026-10-07).
//
//   Solstice    [Apollo Cold Filters] -> Lead found              [On]
//   Sparkle     [LinkedIn Engagement Signals] -> Lead found      [Off]
//   Jubilation  Lead found -> Sales Cold Email -> Positive reply [On]
//
// campaign-service OWNS on/off: a source campaign is its campaign keyed (offer,
// featureSlug = <origin slug>, legKey = "start_to_lead_found"). This service keeps
// the offer's AUDIENCES in step with it, because campaigns serve the offer's ACTIVE
// audiences (features-service enumerates them, campaign-service's bandit picks one,
// lead-service serves it):
//   - ON  = the origin's audience exists for the offer and is active. The audiences an
//           earlier OFF paused are resumed; if none of that list is active, a paused one
//           is resumed; if the offer holds none (archived aside), one is CREATED, done for
//           the customer from what the platform already knows (never asks them anything):
//             apollo_search         the offer's validated target, split (audience-split.ts)
//             apollo_buying_signal  per client profile of the offer, one list per signal
//                                   above threshold (profile-sources.ts)
//             linkedin_engagement   per client profile, competitors' LinkedIn pages
//                                   brand-service found (competitor-engagement-audience.ts)
//             crm_contacts          one audience per CRM file the brand uploaded
//   - OFF = every active audience of that list under the offer is PAUSED, history kept,
//           and HELD (source_campaign_audience_holds) so the next ON resumes exactly those.
//   SOURCES (AUDIENCE-SOURCES-1016, audience-sources.ts): a buying signal / competitor
//   engagement is a SOURCE of a profile audience, not an audience. ON/OFF of its origin
//   flips the offer's source entries of that list; OFF of an audience's OWN list marks it
//   off (`own_source_status`) and pauses the audience only when none of its sources is
//   still ON. An audience runs while one of its sources is ON.
//   A list a person's profile pause holds (audience_profile_holds, profile-sources.ts)
//   is never resumed by an ON: it runs again only once neither holds it.
//   An ON NEVER resumes an audience a PERSON paused (or one whose pause nobody recorded):
//   only a system pause is resumable (audience-status-origin.ts, LEAK-1012).
// The list an origin is comes from features-service's catalogue (sourcing-origin.ts).
//
// HOW ON/OFF REACHES US (both idempotent, both through applySourceCampaignState):
//   1. PUSH: POST /orgs/source-campaigns/state {brandId, offerId, originSlug, campaignId,
//      status} — the explicit "it changed" (campaign-service, staff). Always applied.
//   2. RECONCILE: every RECONCILE_INTERVAL_MS, for every (org, brand, offer) holding
//      audiences or a recorded state, read campaign-service
//      GET /internal/offers/{offerId}/source-campaigns and apply what CHANGED against
//      source_campaign_states (the last state applied). A source campaign seen for the
//      FIRST time is never a transition: rows migrated from today's state (campaign-
//      service mirrors the outreach status) must not move anything. So a first sighting
//      only records the state, and an ON one creates an audience ONLY when the offer holds
//      no audience of that list at all (the customer just turned a new source on). A
//      first-seen OFF pauses nothing.
//
// Spend: pausing, resuming and recording are free. Creating spends what the matching
// list build always spends (split LLM, Apollo exploration, competitor discovery),
// org-billed under a `source-campaign-audience` run labelled with the origin slug and
// the source campaign id: only ever because the customer turned that source ON.

import { errorMessage } from "../lib/db-error.js";
import { ensureProfileAvatar } from "./audience-avatar.js";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  audiencePortfolios,
  audiences,
  sourceCampaignAudienceHolds,
  sourceCampaignStates,
  type SourceCampaignState,
} from "../db/schema.js";
import { audienceListKind } from "./audience-snapshot.js";
import { listKindOfOriginSlug, withSourcingOrigin, type AudienceListKind } from "./sourcing-origin.js";
import { fetchOfferSourceCampaigns } from "../lib/campaign-source-campaigns.js";
import { crmListUploads } from "../lib/crm-contacts.js";
import { ensureCompetitorEngagementAudience } from "./competitor-engagement-audience.js";
import { ensureProfileSignalLists, profileHeldIds, profileListsDue } from "./profile-sources.js";
import { confirmAudienceSplit, proposeAudienceSplit } from "./audience-split.js";
import { dedupeSegmentNames, pickValidatedTarget } from "./audience-refill.js";
import { ensureApolloPointer } from "./audiences.js";
import { ensureTargetText } from "./audience-target-text.js";
import { completeRun, createRun } from "./runs.js";
import type { Identity } from "./people-providers.js";
import { getMigrationState } from "../lib/migration-state.js";
import { ensureLeadSourcingChoice, LEAD_SOURCING_SLUG } from "./lead-sourcing.js";
import { isSystemResumable, systemResumable, systemStatus } from "./audience-status-origin.js";
import { isSourceOn, offerSources, ownListOn, setOfferSourcesStatus, sourcesOf, syncAudienceLiveness } from "./audience-sources.js";
import { noteListBuilt } from "./run-outputs.js";
import { withRunOutputs } from "./run-outputs.js";

type AudienceRow = typeof audiences.$inferSelect;

export type SourceState = "on" | "off";

export const SOURCE_CAMPAIGN_SOURCE = "source_campaign";

/** What applying a state did. */
export type SourceOutcome =
  | "paused" // OFF: active audiences paused and held
  | "none_active" // OFF: nothing of that list was active
  | "active" // ON: the list already had an active audience, nothing to do
  | "resumed" // ON: held / paused audiences resumed
  | "created" // ON: an audience was created
  | "no_target" // ON: nothing known to build the list from (no target, no CRM file, no competitor page)
  | "not_computed" // ON: competitors not computed yet (the next reconcile retries)
  | "exists_inactive" // ON (first sighting): the offer holds the list, none active, left as the person set it
  | "recorded" // first sighting: state recorded, nothing moved
  | "unchanged" // the recorded state already says so
  | "retired_origin" // ON of an origin nothing serves from any more
  | "failed";

export interface SourceAudienceView {
  id: string;
  name: string;
  /** The audience's status; for an audience reached through a SOURCE of the list, that source's. */
  status: string;
  /** Set when the audience is reached through a source of the list (audience-sources.ts). */
  sourceId?: string;
}

export interface ApplySourceResult {
  orgId: string;
  brandId: string;
  offerId: string;
  originSlug: string;
  listKind: AudienceListKind | null;
  campaignId: string | null;
  status: SourceState;
  previousStatus: SourceState | null;
  outcome: SourceOutcome;
  reason: string | null;
  /** The offer's audiences of that list after applying. */
  audiences: SourceAudienceView[];
}

export class UnknownSourceOriginError extends Error {
  constructor(public readonly originSlug: string) {
    super(`"${originSlug}" is not a sourcing origin the features-service catalogue names`);
    this.name = "UnknownSourceOriginError";
  }
}

export interface ApplySourceArgs {
  orgId: string;
  brandId: string;
  offerId: string;
  originSlug: string;
  campaignId: string | null;
  status: SourceState;
  /** The person (or the brand's audience creator) list builds are billed under. */
  userId?: string | null;
  /**
   * `transition`: apply fully (push, or the reconcile saw a change).
   * `first_sighting`: record only; an ON creates the list only when the offer holds none.
   */
  mode: "transition" | "first_sighting";
}

const RETIRED_LISTS = new Set<AudienceListKind>(["apify_search"]);

/**
 * The origins an outreach channel found its leads from BEFORE sources were campaigns
 * (campaign-service DEFAULT_SOURCE_ORIGIN_BY_CHANNEL: cold email -> Apollo Cold Filters,
 * CRM email -> Your CRM Contacts). campaign-service creates them ON by itself (its
 * migration mirrors the outreach status, a first outreach start is born with it), so a
 * first-seen ON of one is TODAY'S state, never a customer's new choice: it builds nothing
 * (prod 2026-10-07: an offer whose cold-email outreach runs with no live audience would
 * otherwise have been given new audiences, and spend, it never asked for). Any other
 * origin is only mirrored when it already spent (its list exists), so a first-seen ON of
 * one with no list is a person who just turned it on.
 */
const DEFAULT_ORIGINS = new Set(["sourcing-apollo-cold-filters", "sourcing-crm-contacts"]);

// One apply per scope at a time in this process (push and reconcile can meet).
const scopeLocks = new Map<string, Promise<unknown>>();
function withScopeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = scopeLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  scopeLocks.set(key, next);
  void next.finally(() => {
    if (scopeLocks.get(key) === next) scopeLocks.delete(key);
  });
  return next;
}

async function loadState(a: { orgId: string; brandId: string; offerId: string; originSlug: string }) {
  const [row] = await db
    .select()
    .from(sourceCampaignStates)
    .where(
      and(
        eq(sourceCampaignStates.orgId, a.orgId),
        eq(sourceCampaignStates.brandId, a.brandId),
        eq(sourceCampaignStates.offerId, a.offerId),
        eq(sourceCampaignStates.originSlug, a.originSlug)
      )
    );
  return row ?? null;
}

/** The offer's audiences of one list (deprecated rows are never part of it). */
async function listAudiences(a: { orgId: string; brandId: string; offerId: string }, list: AudienceListKind) {
  const rows = await db
    .select()
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, a.orgId),
        eq(audiences.brandId, a.brandId),
        eq(audiences.offerId, a.offerId),
        notInArray(audiences.status, ["deprecated"])
      )
    )
    .orderBy(desc(audiences.updatedAt));
  return rows.filter((r) => audienceListKind(r) === list);
}

/**
 * The list is ON for the offer: an active audience whose own list it is (and on),
 * or an active source of that list on an active audience.
 */
async function listRunning(scope: { orgId: string; brandId: string; offerId: string }, list: AudienceListKind, rows: AudienceRow[]): Promise<boolean> {
  if (rows.some((r) => r.status === "active" && ownListOn(r))) return true;
  const sources = (await offerSources(scope, list)).filter(isSourceOn);
  if (sources.length === 0) return false;
  const parents = await db
    .select({ id: audiences.id })
    .from(audiences)
    .where(and(inArray(audiences.id, sources.map((s) => s.audienceId)), eq(audiences.status, "active")));
  return parents.length > 0;
}

function view(rows: AudienceRow[]): SourceAudienceView[] {
  return rows
    .filter((r) => r.status !== "deprecated")
    .map((r) => ({ id: r.id, name: r.name, status: r.status }));
}

/** The offer's audiences of the list: those whose own list it is, then those reached through a source of it. */
async function listView(scope: { orgId: string; brandId: string; offerId: string }, list: AudienceListKind): Promise<SourceAudienceView[]> {
  const own = view(await listAudiences(scope, list));
  const sources = (await offerSources(scope, list)).filter((s) => s.status !== "archived");
  if (sources.length === 0) return own;
  const parents = await db
    .select({ id: audiences.id, name: audiences.name })
    .from(audiences)
    .where(inArray(audiences.id, sources.map((s) => s.audienceId)));
  const names = new Map(parents.map((p) => [p.id, p.name]));
  return [
    ...own,
    ...sources.map((s) => ({ id: s.audienceId, name: names.get(s.audienceId) ?? "", status: s.status, sourceId: s.id })),
  ];
}

/**
 * Resume what the SYSTEM paused among `ids` (a person's pause, or one nobody recorded,
 * is never touched: LEAK-1012). Returns the ids resumed.
 */
async function resumeSystemPaused(ids: string[], tx: Pick<typeof db, "update"> = db): Promise<string[]> {
  if (ids.length === 0) return [];
  const back = await tx
    .update(audiences)
    .set({ status: "active", updatedAt: new Date(), ...systemStatus("source_campaign_on") })
    .where(systemResumable(ids))
    .returning({ id: audiences.id });
  return back.map((r) => r.id);
}

const PERSON_PAUSED_REASON = "paused by a person (or by nobody we can name): only a person resumes it";

/**
 * Apply one source campaign's on/off to the offer's audiences. Idempotent: the same
 * state twice moves nothing the second time. Throws UnknownSourceOriginError for a slug
 * the catalogue does not name (a 400 at the route); any other failure is the `failed`
 * outcome, recorded and logged loud, never thrown.
 */
export async function applySourceCampaignState(args: ApplySourceArgs): Promise<ApplySourceResult> {
  const list = await listKindOfOriginSlug(args.originSlug);
  if (!list) throw new UnknownSourceOriginError(args.originSlug);
  const key = `${args.orgId}:${args.brandId}:${args.offerId}:${args.originSlug}`;
  return withScopeLock(key, () => applyLocked(args, list));
}

async function applyLocked(args: ApplySourceArgs, list: AudienceListKind): Promise<ApplySourceResult> {
  const scope = { orgId: args.orgId, brandId: args.brandId, offerId: args.offerId };
  const prior = await loadState({ ...scope, originSlug: args.originSlug });
  const result: ApplySourceResult = {
    ...scope,
    originSlug: args.originSlug,
    listKind: list,
    campaignId: args.campaignId,
    status: args.status,
    previousStatus: (prior?.status as SourceState | undefined) ?? null,
    outcome: "failed",
    reason: null,
    audiences: [],
  };

  // Recorded already: nothing changed, nothing to move (a push repeating the reconcile).
  if (prior && prior.status === args.status && args.mode === "first_sighting") {
    result.outcome = "unchanged";
    result.audiences = await listView(scope, list);
    return result;
  }

  try {
    if (args.mode === "first_sighting") {
      await firstSighting(args, list, result);
    } else if (args.status === "off") {
      await turnOff(args, list, result);
    } else {
      await turnOn(args, list, result);
    }
  } catch (err) {
    result.outcome = "failed";
    result.reason = errorMessage(err);
  }
  result.audiences = await listView(scope, list);
  await recordState(args, list, result, prior);

  const line =
    `[human-service] source_campaign.${result.outcome} org=${args.orgId} brand=${args.brandId} offer=${args.offerId} ` +
    `origin=${args.originSlug} campaign=${args.campaignId ?? "-"} status=${args.status} prev=${result.previousStatus ?? "-"} ` +
    `mode=${args.mode} audiences=${result.audiences.map((a) => `${a.id}:${a.status}`).join(",") || "-"}` +
    (result.reason ? ` reason=${JSON.stringify(result.reason)}` : "");
  if (result.outcome === "failed") console.error(line);
  else console.log(line);
  return result;
}

async function recordState(
  args: ApplySourceArgs,
  list: AudienceListKind,
  result: ApplySourceResult,
  prior: SourceCampaignState | null
) {
  // A failed ON is recorded as NOT applied (status off when nothing was before), so the
  // next reconcile retries it; a failed OFF likewise stays on.
  const failed = result.outcome === "failed" || result.outcome === "not_computed";
  const status = failed ? (prior?.status ?? (args.status === "on" ? "off" : "on")) : args.status;
  const now = new Date();
  await db
    .insert(sourceCampaignStates)
    .values({
      orgId: args.orgId,
      brandId: args.brandId,
      offerId: args.offerId,
      originSlug: args.originSlug,
      listKind: list,
      campaignId: args.campaignId,
      status,
      outcome: result.outcome,
      outcomeReason: result.reason,
      appliedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        sourceCampaignStates.orgId,
        sourceCampaignStates.brandId,
        sourceCampaignStates.offerId,
        sourceCampaignStates.originSlug,
      ],
      set: {
        listKind: list,
        campaignId: args.campaignId,
        status,
        outcome: result.outcome,
        outcomeReason: result.reason,
        appliedAt: now,
        updatedAt: now,
      },
    });
}

async function firstSighting(args: ApplySourceArgs, list: AudienceListKind, result: ApplySourceResult) {
  const scope = { orgId: args.orgId, brandId: args.brandId, offerId: args.offerId };
  if (args.status === "off") {
    result.outcome = "recorded";
    return;
  }
  if (RETIRED_LISTS.has(list)) {
    result.outcome = "recorded";
    return;
  }
  const rows = await listAudiences(scope, list);
  if (await listRunning(scope, list, rows)) {
    result.outcome = "active";
    return;
  }
  // The offer already holds this list (paused / suggested / archived by a person, or
  // exhausted): today's state, left exactly as it is.
  if (rows.length > 0 || (await offerSources(scope, list)).length > 0) {
    result.outcome = "exists_inactive";
    return;
  }
  if (DEFAULT_ORIGINS.has(args.originSlug)) {
    result.outcome = "recorded";
    result.reason = "default origin first seen ON: today's state, nothing built";
    return;
  }
  await createList(args, list, result);
}

async function turnOff(args: ApplySourceArgs, list: AudienceListKind, result: ApplySourceResult) {
  const scope = { orgId: args.orgId, brandId: args.brandId, offerId: args.offerId };
  const rows = await listAudiences(scope, list);
  // The audiences whose OWN list this is: that list is off.
  const own = rows.filter((r) => r.status !== "archived" && ownListOn(r));
  if (own.length > 0) {
    await db
      .update(audiences)
      .set({ ownSourceStatus: "paused" })
      .where(inArray(audiences.id, own.map((r) => r.id)));
  }
  // The offer's SOURCES of that list: off. An audience whose last ON source this was
  // pauses (held under this origin, so its ON resumes it).
  const { changed } = await setOfferSourcesStatus(scope, list, "paused", "source_campaign_off");
  const hold = { scope, originSlug: args.originSlug, campaignId: args.campaignId };
  await syncAudienceLiveness(changed.map((s) => s.audienceId), hold);

  // An audience still running through another source keeps running.
  const withSources = await sourcesOf(rows.map((r) => r.id));
  const keepsRunning = (r: AudienceRow) => (withSources.get(r.id) ?? []).some(isSourceOn);
  const active = rows.filter((r) => r.status === "active" && !keepsRunning(r));
  // A list paused by its profile is held too, so resuming the profile while the
  // source is still OFF does not revive it.
  const profileHeld = await profileHeldIds(rows.filter((r) => r.status === "paused").map((r) => r.id));
  const ids = [...active.map((r) => r.id), ...profileHeld];
  if (ids.length === 0) {
    result.outcome = changed.length > 0 || own.some((r) => r.status === "active") ? "paused" : "none_active";
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(audiences)
      .set({ status: "paused", updatedAt: new Date(), ...systemStatus("source_campaign_off") })
      .where(and(inArray(audiences.id, ids), eq(audiences.status, "active")));
    await tx
      .insert(sourceCampaignAudienceHolds)
      .values(
        ids.map((audienceId) => ({
          ...scope,
          originSlug: args.originSlug,
          audienceId,
          campaignId: args.campaignId,
        }))
      )
      .onConflictDoNothing();
  });
  result.outcome = active.length > 0 || changed.length > 0 || own.some((r) => r.status === "active") ? "paused" : "none_active";
}

async function turnOn(args: ApplySourceArgs, list: AudienceListKind, result: ApplySourceResult) {
  const scope = { orgId: args.orgId, brandId: args.brandId, offerId: args.offerId };
  if (RETIRED_LISTS.has(list)) {
    result.outcome = "retired_origin";
    result.reason = `${args.originSlug} is retired: nothing serves from it any more`;
    return;
  }

  // 1. Resume exactly what an OFF paused (still paused BY THE SYSTEM: a person who changed
  // it since wins, and their PATCH closed the hold anyway).
  const holds = await db
    .select()
    .from(sourceCampaignAudienceHolds)
    .where(
      and(
        eq(sourceCampaignAudienceHolds.orgId, args.orgId),
        eq(sourceCampaignAudienceHolds.brandId, args.brandId),
        eq(sourceCampaignAudienceHolds.offerId, args.offerId),
        eq(sourceCampaignAudienceHolds.originSlug, args.originSlug),
        isNull(sourceCampaignAudienceHolds.releasedAt)
      )
    );
  let resumed = 0;
  if (holds.length > 0) {
    // A list its profile's pause still holds stays paused (the profile's resume revives it).
    const profileHeld = await profileHeldIds(holds.map((h) => h.audienceId));
    const heldIds = holds.map((h) => h.audienceId).filter((id) => !profileHeld.has(id));
    await db.transaction(async (tx) => {
      resumed = (await resumeSystemPaused(heldIds, tx)).length;
      await tx
        .update(sourceCampaignAudienceHolds)
        .set({ releasedAt: new Date() })
        .where(and(inArray(sourceCampaignAudienceHolds.id, holds.map((h) => h.id)), isNull(sourceCampaignAudienceHolds.releasedAt)));
    });
  }

  // The audiences whose OWN list this is: on again. The offer's SOURCES of that list:
  // on, and an audience a source campaign OFF paused runs again through them.
  const ownRows = (await listAudiences(scope, list)).filter((r) => !ownListOn(r));
  if (ownRows.length > 0) {
    await db
      .update(audiences)
      .set({ ownSourceStatus: "active" })
      .where(inArray(audiences.id, ownRows.map((r) => r.id)));
  }
  const { changed } = await setOfferSourcesStatus(scope, list, "active", "source_campaign_on");
  resumed += (
    await syncAudienceLiveness([...changed.map((s) => s.audienceId), ...ownRows.map((r) => r.id)])
  ).resumed.length;

  // A source built per client profile: every live profile still without its list
  // gets one now (an offer still served by a whole-ICP list moves to per-profile
  // lists here, the whole-ICP one retired).
  if ((list === "apollo_buying_signal" || list === "linkedin_engagement") && (await profileListsDue(scope, list))) {
    await createList(args, list, result);
    if (result.outcome === "created" || result.outcome === "failed" || result.outcome === "not_computed") return;
    result.reason = null;
  }

  const rows = await listAudiences(scope, list);
  if (await listRunning(scope, list, rows)) {
    result.outcome = resumed > 0 || changed.length > 0 ? "resumed" : "active";
    return;
  }

  // 2. Nothing of the list is active: the most recent SYSTEM-paused one serves again (a
  // suggested / archived one is not theirs to revive). A list a PERSON paused (or whose
  // pause nobody recorded) stays exactly as they set it, and nothing new is built beside
  // it: the person decides (LEAK-1012, prod 2026-10-12: a stopped funnel's source turned
  // back on resumed a paused audience that served 60 prospects into a signup campaign).
  const pausedRows = rows.filter((r) => r.status === "paused");
  const profileHeld = await profileHeldIds(pausedRows.map((r) => r.id));
  const paused = pausedRows.find((r) => isSystemResumable(r) && !profileHeld.has(r.id));
  if (paused) {
    const back = await resumeSystemPaused([paused.id]);
    if (back.length > 0) {
      result.outcome = "resumed";
      return;
    }
  }
  if (pausedRows.some((r) => !isSystemResumable(r))) {
    result.outcome = "exists_inactive";
    result.reason = PERSON_PAUSED_REASON;
    return;
  }

  // 3. The offer holds no live audience of that list: build one.
  await createList(args, list, result);
}

// ── Creating the list (done for the customer) ────────────────────────────────────

/** The user a list build is billed under: the caller, else the brand's audience creator. */
async function billingUser(args: ApplySourceArgs): Promise<string | null> {
  if (args.userId) return args.userId;
  const [row] = await db
    .select({ userId: audiences.createdByUserId })
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, args.orgId),
        eq(audiences.brandId, args.brandId),
        sql`${audiences.createdByUserId} is not null`
      )
    )
    .orderBy(sql`(${audiences.offerId} = ${args.offerId}) desc nulls last`, desc(audiences.createdAt))
    .limit(1);
  return row?.userId ?? null;
}

/** The target the customer validated for the offer (its audiences, then its launch). */
async function offerTarget(args: ApplySourceArgs): Promise<string | null> {
  const rows = await db
    .select()
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, args.orgId),
        eq(audiences.brandId, args.brandId),
        eq(audiences.offerId, args.offerId),
        notInArray(audiences.status, ["deprecated"])
      )
    );
  const fromAudiences = pickValidatedTarget(rows);
  if (fromAudiences) return fromAudiences;
  const [portfolio] = await db
    .select({ target: audiencePortfolios.target, icpText: audiencePortfolios.icpText })
    .from(audiencePortfolios)
    .where(
      and(
        eq(audiencePortfolios.orgId, args.orgId),
        eq(audiencePortfolios.brandId, args.brandId),
        eq(audiencePortfolios.offerId, args.offerId)
      )
    );
  return portfolio?.target?.trim() || portfolio?.icpText?.trim() || null;
}

async function createList(args: ApplySourceArgs, list: AudienceListKind, result: ApplySourceResult) {
  const userId = await billingUser(args);
  if (!userId) {
    result.outcome = "failed";
    result.reason = "no user to bill the list build under (the brand has no audience creator and the call named none)";
    return;
  }
  const tracking = {
    brandIds: [args.brandId],
    featureSlug: args.originSlug,
    ...(args.campaignId ? { campaignId: args.campaignId } : {}),
  };
  const runId = await createRun({ orgId: args.orgId, userId, taskName: "source-campaign-audience", workflowTracking: tracking });
  if (!runId) {
    result.outcome = "failed";
    result.reason = "runs-service did not open a run for the list build";
    return;
  }
  const runIdentity = { orgId: args.orgId, userId, workflowTracking: tracking };
  const identity: Identity = withSourcingOrigin(
    { orgId: args.orgId, userId, runId, brandIds: [args.brandId], workflowTracking: tracking },
    args.originSlug
  );
  let ok = false;
  try {
    await withRunOutputs(runId, async () => {
      if (list === "linkedin_engagement") await createEngagement(args, userId, identity, result);
      else if (list === "apollo_search") await createColdFilters(args, userId, identity, result);
      else if (list === "apollo_buying_signal") await createBuyingSignals(args, userId, identity, result);
      else if (list === "crm_contacts") await createCrmAudiences(args, userId, identity, result);
      else {
        result.outcome = "retired_origin";
        result.reason = `nothing builds a ${list} list any more`;
      }
    });
    ok = result.outcome !== "failed";
  } finally {
    await completeRun(runId, ok ? "completed" : "failed", runIdentity);
  }
}

async function createEngagement(args: ApplySourceArgs, userId: string, identity: Identity, result: ApplySourceResult) {
  const out = await ensureCompetitorEngagementAudience({
    orgId: args.orgId,
    userId,
    brandId: args.brandId,
    offerId: args.offerId,
    identity,
    ignoreArchived: true,
    // The source is being turned ON: born active (its recorded state is written after).
    status: "active",
  });
  if (out.outcome === "created") {
    result.outcome = "created";
  } else if (out.outcome === "exists" && out.audienceIds.length > 0) {
    // Born or left inactive by the system: the source is ON, so they serve (a profile a
    // person paused keeps its source unserved; a list a person paused stays paused).
    const scope = { orgId: args.orgId, brandId: args.brandId, offerId: args.offerId };
    await setOfferSourcesStatus(scope, "linkedin_engagement", "active", "source_campaign_on");
    await syncAudienceLiveness(out.audienceIds);
    // Legacy per-profile lists (rows of their own, pre-merge) resume as before.
    const legacy = (
      await db
        .select({ id: audiences.id, profileAudienceId: audiences.profileAudienceId })
        .from(audiences)
        .where(inArray(audiences.id, out.audienceIds))
    )
      .filter((r) => r.profileAudienceId)
      .map((r) => r.id);
    const profileHeld = await profileHeldIds(legacy);
    await resumeSystemPaused(legacy.filter((id) => !profileHeld.has(id)));
    const now = await db
      .select({ status: audiences.status })
      .from(audiences)
      .where(inArray(audiences.id, out.audienceIds));
    if (now.some((r) => r.status === "active")) {
      result.outcome = "resumed";
    } else {
      result.outcome = "exists_inactive";
      result.reason = PERSON_PAUSED_REASON;
    }
  } else if (out.outcome === "no_profile") {
    result.outcome = "no_target";
    result.reason = out.reason;
  } else if (out.outcome === "no_pages") {
    result.outcome = "no_target";
    result.reason = out.reason;
  } else if (out.outcome === "not_computed") {
    result.outcome = "not_computed";
    result.reason = out.reason;
  } else {
    result.outcome = "failed";
    result.reason = out.reason;
  }
}

async function createColdFilters(args: ApplySourceArgs, userId: string, identity: Identity, result: ApplySourceResult) {
  const target = await offerTarget(args);
  if (!target) {
    result.outcome = "no_target";
    result.reason = "the offer has no validated target to build Apollo filters from";
    return;
  }
  const split = await proposeAudienceSplit(target, identity);
  const taken = await db
    .select({ name: audiences.name })
    .from(audiences)
    .where(and(eq(audiences.orgId, args.orgId), eq(audiences.brandId, args.brandId), eq(audiences.offerId, args.offerId)));
  const names = dedupeSegmentNames(split.segments.map((s) => s.name), taken.map((t) => t.name));
  const created = await confirmAudienceSplit({
    orgId: args.orgId,
    userId,
    brandId: args.brandId,
    offerId: args.offerId,
    targetAudience: target,
    segments: split.segments.map((s, i) => ({ name: names[i], description: s.description })),
    source: SOURCE_CAMPAIGN_SOURCE,
  });
  // Same background builds as a confirmed split: serve-next builds inline if one has
  // not landed, so a created audience is never unservable.
  for (const row of created) {
    void ensureTargetText(row, { orgId: args.orgId, userId }).catch((err) =>
      console.error(`[human-service] source_campaign.target_text.failed org=${args.orgId} audience=${row.id}`, err)
    );
    void ensureApolloPointer(row, { orgId: args.orgId, userId }).catch((err) =>
      console.error(`[human-service] source_campaign.pointer_build.failed org=${args.orgId} audience=${row.id}`, err)
    );
    void ensureProfileAvatar(row, { orgId: args.orgId, userId }).catch((err) =>
      console.error(`[human-service] source_campaign.avatar_failed org=${args.orgId} audience=${row.id}`, err)
    );
  }
  result.outcome = created.length > 0 ? "created" : "no_target";
  if (created.length === 0) result.reason = "the split of the offer's target returned no segment";
}

async function createBuyingSignals(args: ApplySourceArgs, userId: string, identity: Identity, result: ApplySourceResult) {
  const outcomes = await ensureProfileSignalLists({
    orgId: args.orgId,
    brandId: args.brandId,
    offerId: args.offerId,
    userId,
    identity,
    originSlug: args.originSlug,
    // The source is being turned ON: born active (its recorded state is written after).
    status: "active",
  });
  if (outcomes.length === 0) {
    result.outcome = "no_target";
    result.reason = "the offer has no live client profile to find through buying signals";
    return;
  }
  if (outcomes.some((o) => o.outcome === "created")) {
    result.outcome = "created";
    return;
  }
  const failed = outcomes.filter((o) => o.outcome === "failed");
  result.outcome = failed.length > 0 && failed.length === outcomes.length ? "failed" : "no_target";
  result.reason = outcomes.map((o) => `${o.profileName}/${o.type}:${o.outcome}${o.reason ? ` (${o.reason})` : ""}`).join("; ");
}

async function createCrmAudiences(args: ApplySourceArgs, userId: string, identity: Identity, result: ApplySourceResult) {
  const uploads = await crmListUploads(args.brandId, identity);
  const bound = await db
    .select({ crmUploadId: audiences.crmUploadId, name: audiences.name })
    .from(audiences)
    .where(and(eq(audiences.orgId, args.orgId), eq(audiences.brandId, args.brandId)));
  const boundIds = new Set(bound.map((b) => b.crmUploadId).filter((x): x is string => !!x));
  const fresh = uploads.filter((u) => !boundIds.has(u.id));
  if (fresh.length === 0) {
    result.outcome = "no_target";
    result.reason = uploads.length === 0 ? "the brand has no uploaded or connected contacts" : "every contact file already has its audience";
    return;
  }
  const names = dedupeSegmentNames(
    fresh.map((u) => u.filename.replace(/\.[a-z0-9]+$/i, "") || "Your contacts"),
    bound.map((b) => b.name)
  );
  const rows = await db
    .insert(audiences)
    .values(
      fresh.map((u, i) => ({
        orgId: args.orgId,
        brandId: args.brandId,
        offerId: args.offerId,
        name: names[i],
        description: `The contacts of ${u.filename}.`,
        provider: "crm",
        crmUploadId: u.id,
        status: "active",
        source: SOURCE_CAMPAIGN_SOURCE,
        createdByUserId: userId,
      }))
    )
    .returning();
  for (const r of rows) noteListBuilt(r.id);
  result.outcome = rows.length > 0 ? "created" : "no_target";
}

// ── Reconcile (campaign-service is the truth; apply what changed) ────────────────

export interface ReconcileEntry {
  orgId: string;
  brandId: string;
  offerId: string;
  originSlug: string | null;
  action: SourceOutcome | "would_apply" | "read_failed";
  status: SourceState | null;
  reason: string | null;
}

export interface ReconcileResult {
  dryRun: boolean;
  offers: number;
  applied: number;
  entries: ReconcileEntry[];
}

let reconciling = false;

/**
 * Read every offer's source campaigns and apply each one whose state differs from the
 * state last applied (a first sighting records it, see the header). `dryRun` reads and
 * reports, writes nothing. Returns null when skipped (schema not ready / already running).
 */
export async function runSourceCampaignReconcile(
  opts: { dryRun?: boolean; orgId?: string; offerId?: string } = {}
): Promise<ReconcileResult | null> {
  const dryRun = opts.dryRun ?? false;
  if (reconciling) {
    console.log("[human-service] source_campaign.reconcile_skip reason=already_running");
    return null;
  }
  if (getMigrationState() !== "ready") {
    console.log("[human-service] source_campaign.reconcile_skip reason=migrations_not_ready");
    return null;
  }
  reconciling = true;
  try {
    const filter = sql`${opts.orgId ? sql`and org_id = ${opts.orgId}` : sql``} ${opts.offerId ? sql`and offer_id = ${opts.offerId}` : sql``}`;
    const scopes = (await db.execute(sql`
      select distinct org_id::text as org_id, brand_id::text as brand_id, offer_id::text as offer_id
      from (
        select org_id, brand_id, offer_id from audiences
         where offer_id is not null and status <> 'deprecated'
        union
        select org_id, brand_id, offer_id from source_campaign_states
      ) s
      where true ${filter}
    `)) as unknown as Array<{ org_id: string; brand_id: string; offer_id: string }>;

    const entries: ReconcileEntry[] = [];
    let applied = 0;
    for (const s of scopes) {
      const scope = { orgId: s.org_id, brandId: s.brand_id, offerId: s.offer_id };
      let sources;
      try {
        sources = await fetchOfferSourceCampaigns(scope);
      } catch (err) {
        entries.push({ ...scope, originSlug: null, action: "read_failed", status: null, reason: errorMessage(err) });
        continue;
      }
      const recorded = await db
        .select()
        .from(sourceCampaignStates)
        .where(
          and(
            eq(sourceCampaignStates.orgId, scope.orgId),
            eq(sourceCampaignStates.brandId, scope.brandId),
            eq(sourceCampaignStates.offerId, scope.offerId)
          )
        );
      const byOrigin = new Map(recorded.map((r) => [r.originSlug, r]));
      // LEAD SOURCING (owner 2026-10-11, src/services/lead-sourcing.ts): while it is ON, every origin it CHOSE for
      // the brand is ON exactly as if that origin's own source campaign were (its lists active, held under the
      // Lead Sourcing campaign). It is no list of its own, so it is never applied itself.
      const leadSourcing = sources.find((x) => x.featureSlug === LEAD_SOURCING_SLUG && x.running && x.campaignId) ?? null;
      let chosen = new Set<string>();
      if (leadSourcing) {
        try {
          chosen = new Set((await ensureLeadSourcingChoice(scope, leadSourcing.campaignId)).chosenOriginSlugs);
        } catch (err) {
          // Nothing is moved for this offer this pass: turning its origins OFF on a failed read would stop its leads.
          entries.push({ ...scope, originSlug: LEAD_SOURCING_SLUG, action: "read_failed", status: "on", reason: errorMessage(err) });
          continue;
        }
      }
      for (const src of sources) {
        if (src.featureSlug === LEAD_SOURCING_SLUG) continue;
        const viaLeadSourcing = leadSourcing !== null && !src.running && chosen.has(src.featureSlug);
        // No campaign = never turned on: nothing to keep in step (and nothing applied yet).
        if (!src.campaignId && !viaLeadSourcing && !byOrigin.has(src.featureSlug)) continue;
        const status: SourceState = src.running || viaLeadSourcing ? "on" : "off";
        const campaignId = viaLeadSourcing ? leadSourcing!.campaignId : src.campaignId;
        const prior = byOrigin.get(src.featureSlug) ?? null;
        if (prior && prior.status === status) continue;
        if (dryRun) {
          entries.push({ ...scope, originSlug: src.featureSlug, action: "would_apply", status, reason: prior ? "transition" : "first_sighting" });
          continue;
        }
        try {
          const r = await applySourceCampaignState({
            ...scope,
            originSlug: src.featureSlug,
            campaignId,
            status,
            mode: prior ? "transition" : "first_sighting",
          });
          applied++;
          entries.push({ ...scope, originSlug: src.featureSlug, action: r.outcome, status, reason: r.reason });
        } catch (err) {
          entries.push({ ...scope, originSlug: src.featureSlug, action: "failed", status, reason: errorMessage(err) });
        }
      }
    }
    const failedReads = entries.filter((e) => e.action === "read_failed");
    if (failedReads.length > 0) {
      console.error(
        `[human-service] source_campaign.reconcile_read_failed count=${failedReads.length} first=${JSON.stringify(failedReads[0].reason)}`
      );
    }
    const result: ReconcileResult = { dryRun, offers: scopes.length, applied, entries };
    if (applied > 0 || dryRun) {
      console.log(`[human-service] source_campaign.reconcile${dryRun ? "_dry_run" : ""} offers=${scopes.length} applied=${applied} entries=${entries.length}`);
    }
    return result;
  } finally {
    reconciling = false;
  }
}

const DEFAULT_INITIAL_DELAY_MS = 2 * 60_000;
const DEFAULT_INTERVAL_MS = 2 * 60_000;

function readMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[human-service] source_campaign.bad_env ${name}=${raw} — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Arm the recurring reconcile (timers only, first tick delayed: safe right after
 * `app.listen()`). `SOURCE_CAMPAIGN_RECONCILE_INTERVAL_MS=0` is the off switch.
 */
export function startSourceCampaignReconcile(): () => void {
  const intervalMs = readMs("SOURCE_CAMPAIGN_RECONCILE_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  if (intervalMs === 0) {
    console.log("[human-service] source_campaign.reconcile_disabled interval=0");
    return () => {};
  }
  const initialDelayMs = readMs("SOURCE_CAMPAIGN_RECONCILE_INITIAL_DELAY_MS", DEFAULT_INITIAL_DELAY_MS);
  console.log(`[human-service] source_campaign.reconcile_armed initialDelayMs=${initialDelayMs} intervalMs=${intervalMs}`);
  const tick = () => {
    void runSourceCampaignReconcile().catch((err) => console.error("[human-service] source_campaign.reconcile_failed", err));
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
