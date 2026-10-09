// The "engaged with competitor posts" audience, created BY US for every client
// brand (owner 2026-10-03: "c'est à nous de gérer nos audiences, on est censé
// connaître les competitors de notre client et leurs LinkedIn"). No client input.
//
// What: one linkedin_engagement signal audience (linkedin-engagement-audience.ts)
// per CLIENT PROFILE of the offer (profile-sources.ts, owner 2026-10-09), built
// from up to 3 competitor LinkedIn company pages brand-service found
// (src/lib/brand-competitors.ts). Every list engages the same pages; each screens
// the engagers against ITS profile's text, so pausing a profile stops its list.
// apollo-service reads a page's posts and engagement once a day whoever asks, so
// one list per profile re-reads nothing. Born ACTIVE (see bornStatus) so
// campaigns test it against the other audiences. The offer's earlier whole-ICP
// engagement list is retired once every profile has its own.
//
// When:
//   - at portfolio launch (audience-portfolio.ts, background phase);
//   - on the recurring sweep (runCompetitorEngagementSweep, same tick as the
//     refill) for every brand with an active audience whose billing can charge
//     it: existing brands, and brands whose competitors were not computed yet.
//
// Outcomes, each logged with its reason:
//   created       at least one profile's list created
//   exists        every live profile already holds one (any status): never duplicated
//   no_profile    the offer has no live client profile to build a list for
//   no_pages      competitors computed, none with a LinkedIn page: nothing created
//   not_computed  brand-service has no answer yet: retried by the next sweep
//   failed        a read or the creation failed: retried by the next sweep
//
// Cost (owner rule 2026-10-03, binding): creating the audience costs NOTHING.
// apollo-service's POST /audiences/signal for this kind persists the criterion
// only (no count, no harvest, no reveal). Spend happens only when a campaign
// serves it, one lead at a time (teaser screened before the paid reveal). The
// one paid step upstream is brand-service's competitor discovery (a fraction of
// a cent of model tokens, once per brand, declared by brand-service), which is
// why the sweep only runs it for orgs billing can charge.

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiencePortfolios, audiences, sourceCampaignStates } from "../db/schema.js";
import { BUYING_SIGNAL_TYPES } from "../lib/apollo-audiences.js";

type AudienceRow = typeof audiences.$inferSelect;
import { discoverBrandCompetitors, type BrandCompetitor } from "../lib/brand-competitors.js";
import { canBeCharged, getPaymentOutlook } from "../lib/billing-outlook.js";
import { getMigrationState } from "../lib/migration-state.js";
import { dedupeSegmentNames, pickOffer } from "./audience-refill.js";
import { createLinkedinEngagementAudience } from "./linkedin-engagement-audience.js";
import type { Identity } from "./people-providers.js";
import { completeRun, createRun } from "./runs.js";
import { sourcingOriginSlug, withSourcingOrigin } from "./sourcing-origin.js";
import {
  bornStatus,
  ensureProfileSignalLists,
  holdBornList,
  liveProfiles,
  profileListName,
  readyProfile,
  retireWholeIcpLists,
  sourceKeyOf,
  type ProfileSignalOutcome,
} from "./profile-sources.js";

/** apollo-service accepts 1-3 competitor pages per audience. */
export const MAX_COMPETITOR_PAGES = 3;
/** Age of the competitor posts whose engagers are served (rolling). A like or a
 * comment is a fresh, short-lived sign of interest: one month. */
export const COMPETITOR_ENGAGEMENT_WINDOW_DAYS = 30;
export const COMPETITOR_ENGAGEMENT_NAME = "Engaged with competitor posts";

export type CompetitorEngagementOutcomeKind = "created" | "exists" | "no_profile" | "no_pages" | "not_computed" | "failed";

export interface CompetitorEngagementOutcome {
  orgId: string;
  brandId: string;
  offerId: string | null;
  outcome: CompetitorEngagementOutcomeKind;
  /** The first of `audienceIds` (one list per profile). */
  audienceId: string | null;
  /** The offer's per-profile engagement lists after this call. */
  audienceIds: string[];
  pages: string[];
  reason: string | null;
}

/**
 * Up to MAX_COMPETITOR_PAGES distinct LinkedIn company pages, in brand-service's
 * order (its most direct competitors first). Only pages brand-service read off a
 * competitor's own website: nothing is invented here.
 */
export function pickCompetitorPages(competitors: BrandCompetitor[]): string[] {
  const seen = new Set<string>();
  const pages: string[] = [];
  for (const c of competitors) {
    const url = c.linkedinUrl?.trim();
    if (!url) continue;
    const key = url.toLowerCase().replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push(url);
    if (pages.length >= MAX_COMPETITOR_PAGES) break;
  }
  return pages;
}

const inFlight = new Map<string, Promise<CompetitorEngagementOutcome>>();

export interface EnsureEngagementArgs {
  orgId: string;
  userId: string;
  brandId: string;
  offerId: string;
  identity: Identity;
  /** An archived list does not count as existing (source campaign ON). Default false. */
  ignoreArchived?: boolean;
  /** Born status. Default: bornStatus (source campaign, the retired whole-ICP list, siblings). */
  status?: "active" | "paused";
}

/**
 * Give every live profile of the offer its competitor-engagement list unless it
 * already has one. Never throws: every failure is the `failed` outcome, logged loud.
 */
export async function ensureCompetitorEngagementAudience(args: EnsureEngagementArgs): Promise<CompetitorEngagementOutcome> {
  const key = `${args.orgId}:${args.brandId}:${args.offerId}:${args.ignoreArchived ? "live" : "any"}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = ensureOnce(args).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** Each live profile's engagement list (any status; archived ones only when counted). */
function engagementListOf(rows: AudienceRow[], profileId: string, ignoreArchived: boolean): AudienceRow | null {
  return (
    rows.find(
      (r) =>
        r.profileAudienceId === profileId &&
        sourceKeyOf(r) === "linkedin_engagement" &&
        r.status !== "deprecated" &&
        !(ignoreArchived && r.status === "archived")
    ) ?? null
  );
}

async function offerAudiences(orgId: string, brandId: string, offerId: string): Promise<AudienceRow[]> {
  return db
    .select()
    .from(audiences)
    .where(and(eq(audiences.orgId, orgId), eq(audiences.brandId, brandId), eq(audiences.offerId, offerId)))
    .orderBy(audiences.createdAt);
}

async function ensureOnce(args: EnsureEngagementArgs): Promise<CompetitorEngagementOutcome> {
  const scope = { orgId: args.orgId, brandId: args.brandId, offerId: args.offerId };
  const out: CompetitorEngagementOutcome = {
    ...scope,
    outcome: "failed",
    audienceId: null,
    audienceIds: [],
    pages: [],
    reason: null,
  };
  const done = (o: Partial<CompetitorEngagementOutcome>): CompetitorEngagementOutcome => {
    Object.assign(out, o);
    out.audienceId = out.audienceIds[0] ?? null;
    const line = `[human-service] competitor_engagement.${out.outcome} org=${out.orgId} brand=${out.brandId} offer=${out.offerId ?? "-"} audiences=${out.audienceIds.join(",") || "-"} pages=${out.pages.length}${out.reason ? ` reason=${JSON.stringify(out.reason)}` : ""}`;
    if (out.outcome === "failed") console.error(line);
    else console.log(line);
    return out;
  };
  const ignoreArchived = args.ignoreArchived ?? false;

  try {
    let rows = await offerAudiences(args.orgId, args.brandId, args.offerId);
    const profiles = await liveProfiles(scope, rows.filter((r) => r.status !== "deprecated"));
    if (profiles.length === 0) return done({ outcome: "no_profile", reason: "the offer has no live client profile" });
    const listIds = () =>
      profiles.map((p) => engagementListOf(rows, p.id, ignoreArchived)?.id).filter((x): x is string => !!x);
    let missing = profiles.filter((p) => !engagementListOf(rows, p.id, ignoreArchived));
    if (missing.length === 0) {
      await retireWholeIcpLists(scope, "linkedin_engagement");
      return done({ outcome: "exists", audienceIds: listIds() });
    }

    // Building these lists is linkedin_engagement sourcing: the discovery and the
    // creations carry that origin (unresolvable ⟹ failed, nothing spent).
    const originSlug = await sourcingOriginSlug("linkedin_engagement");
    const identity = withSourcingOrigin(args.identity, originSlug);
    const answer = await discoverBrandCompetitors(args.brandId, identity);
    if (answer.status === "not_computed") return done({ outcome: "not_computed", reason: answer.reason, audienceIds: listIds() });
    const pages = pickCompetitorPages(answer.competitors);
    if (pages.length === 0) {
      return done({
        outcome: "no_pages",
        audienceIds: listIds(),
        reason:
          answer.competitors.length === 0
            ? "brand-service found no competitor"
            : `none of the ${answer.competitors.length} competitors links a LinkedIn company page`,
      });
    }

    // Re-read after the (possibly slow) discovery: a concurrent path may have
    // created some meanwhile.
    rows = await offerAudiences(args.orgId, args.brandId, args.offerId);
    missing = profiles.filter((p) => !engagementListOf(rows, p.id, ignoreArchived));
    // The legacy rule for an offer whose sources are not campaigns: born active,
    // unless the offer's sources ARE campaigns and LinkedIn's is not on.
    const fallback = (await hasSourceStates(scope)) ? "paused" : "active";
    const live = rows.filter((r) => r.status !== "deprecated");
    let created = 0;
    const failures: string[] = [];
    for (const profile of missing) {
      try {
        const ready = await readyProfile(profile, identity);
        const born = args.status
          ? { status: args.status, sourceHold: null }
          : await bornStatus(scope, "linkedin_engagement", originSlug, live, fallback);
        const [name] = dedupeSegmentNames(
          [profileListName(profile, COMPETITOR_ENGAGEMENT_NAME)],
          rows.map((r) => r.name)
        );
        const row = await createLinkedinEngagementAudience({
          orgId: args.orgId,
          userId: args.userId,
          brandId: args.brandId,
          offerId: args.offerId,
          name,
          nlPrompt: ready.text,
          status: born.status,
          windowDays: COMPETITOR_ENGAGEMENT_WINDOW_DAYS,
          competitorPages: pages,
          baseFilters: {},
          profileAudienceId: profile.id,
          identity: { ...identity, brandIds: [args.brandId] },
        });
        await holdBornList(scope, row.id, born);
        rows.push(row);
        live.push(row);
        created++;
      } catch (err) {
        failures.push(`${profile.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length === 0) await retireWholeIcpLists(scope, "linkedin_engagement");
    if (failures.length > 0 && created === 0) {
      return done({ outcome: "failed", reason: failures.join("; "), pages, audienceIds: listIds() });
    }
    return done({
      outcome: "created",
      pages,
      audienceIds: listIds(),
      reason: failures.length > 0 ? failures.join("; ") : null,
    });
  } catch (err) {
    return done({ outcome: "failed", reason: err instanceof Error ? err.message : String(err) });
  }
}

async function hasSourceStates(scope: { orgId: string; brandId: string; offerId: string }): Promise<boolean> {
  const [row] = await db
    .select({ id: sourceCampaignStates.id })
    .from(sourceCampaignStates)
    .where(
      and(
        eq(sourceCampaignStates.orgId, scope.orgId),
        eq(sourceCampaignStates.brandId, scope.brandId),
        eq(sourceCampaignStates.offerId, scope.offerId)
      )
    )
    .limit(1);
  return !!row;
}

// --- Sweep: existing brands, and brands whose competitors were not ready ---

export type SweepSkipReason = "not_chargeable" | "billing_unreadable" | "no_offer" | "no_user" | "run_failed";

export interface SweepEntry {
  orgId: string;
  brandId: string;
  offerId: string | null;
  /** The engagement lists' outcome (or, when only signal lists were due, theirs). */
  action: CompetitorEngagementOutcomeKind | "would_ensure" | "skipped";
  reason: string | null;
  audienceId: string | null;
  /** The offer's per-profile engagement lists. */
  audienceIds: string[];
  pages: string[];
  /** Per (profile, buying signal), when the offer uses buying signals and a pair was due. */
  signals: ProfileSignalOutcome[];
}

export interface CompetitorEngagementSweepResult {
  dryRun: boolean;
  scanned: number;
  created: number;
  entries: SweepEntry[];
}

let sweeping = false;

/**
 * For every (org, brand) holding an ACTIVE audience, on its main offer: every live
 * client profile gets its competitor-engagement list and, when the offer uses
 * buying signals (a launch portfolio, or signal lists already there), its signal
 * lists (profile-sources.ts). A profile added later (refill, accepted widening)
 * gets its lists on the next tick, and an offer's whole-ICP lists are retired once
 * its profiles have their own. Only when billing can charge the org.
 * `dryRun` reads billing (free) and reports, creating and spending nothing.
 * Returns null when skipped (schema not ready or a sweep already running).
 */
export async function runCompetitorEngagementSweep(
  opts: { dryRun?: boolean; brandId?: string } = {}
): Promise<CompetitorEngagementSweepResult | null> {
  const dryRun = opts.dryRun ?? false;
  if (sweeping) {
    console.log("[human-service] competitor_engagement.sweep_skip reason=already_running");
    return null;
  }
  if (getMigrationState() !== "ready") {
    console.log("[human-service] competitor_engagement.sweep_skip reason=migrations_not_ready");
    return null;
  }
  sweeping = true;
  try {
    const active = await db
      .select()
      .from(audiences)
      .where(
        and(eq(audiences.status, "active"), ...(opts.brandId ? [eq(audiences.brandId, opts.brandId)] : []))
      )
      .orderBy(desc(audiences.createdAt));
    const byBrand = new Map<string, typeof active>();
    for (const a of active) {
      const k = `${a.orgId}:${a.brandId}`;
      const list = byBrand.get(k) ?? [];
      list.push(a);
      byBrand.set(k, list);
    }

    const chargeable = new Map<string, { ok: boolean; reason: SweepSkipReason | null; detail: string | null }>();
    const entries: SweepEntry[] = [];
    for (const rows of byBrand.values()) {
      const { orgId, brandId } = rows[0];
      const offerId = pickOffer(rows);
      const entry: SweepEntry = {
        orgId,
        brandId,
        offerId,
        action: "skipped",
        reason: null,
        audienceId: null,
        audienceIds: [],
        pages: [],
        signals: [],
      };
      entries.push(entry);
      if (!offerId) {
        entry.reason = "no_offer";
        continue;
      }
      const scope = { orgId, brandId, offerId };
      const inOffer = await offerAudiences(orgId, brandId, offerId);
      const live = inOffer.filter((r) => r.status !== "deprecated");
      const profiles = await liveProfiles(scope, live);
      if (profiles.length === 0) {
        entry.action = "no_profile";
        continue;
      }
      const engagementDue = profiles.some((p) => !engagementListOf(inOffer, p.id, false));
      const signalsDue = (await offerUsesSignals(scope, live)) && profiles.some((p) => signalTypesMissing(live, p.id));
      if (!engagementDue && !signalsDue) {
        await retireWholeIcpLists(scope, "linkedin_engagement");
        entry.action = "exists";
        entry.audienceIds = profiles.map((p) => engagementListOf(inOffer, p.id, false)?.id).filter((x): x is string => !!x);
        entry.audienceId = entry.audienceIds[0] ?? null;
        continue;
      }
      const userId = live.find((a) => a.createdByUserId)?.createdByUserId ?? null;
      if (!userId) {
        entry.reason = "no_user";
        continue;
      }

      // Billing gate before anything that can spend (the discovery's model call).
      let gate = chargeable.get(orgId);
      if (!gate) {
        try {
          const outlook = await getPaymentOutlook(orgId);
          gate = canBeCharged(outlook)
            ? { ok: true, reason: null, detail: null }
            : { ok: false, reason: "not_chargeable", detail: outlook ? outlook.state : "no_account" };
        } catch (err) {
          gate = { ok: false, reason: "billing_unreadable", detail: err instanceof Error ? err.message : String(err) };
        }
        chargeable.set(orgId, gate);
      }
      if (!gate.ok) {
        entry.reason = `${gate.reason}${gate.detail ? `: ${gate.detail}` : ""}`;
        continue;
      }
      if (dryRun) {
        entry.action = "would_ensure";
        continue;
      }

      if (engagementDue) {
        const result = await underOwnRun(orgId, brandId, userId, "linkedin_engagement", "competitor-engagement-audience", (identity) =>
          ensureCompetitorEngagementAudience({ orgId, userId, brandId, offerId, identity }),
          (v) => v.outcome === "failed"
        );
        if ("skip" in result) {
          entry.reason = result.skip;
          continue;
        }
        entry.action = result.value.outcome;
        entry.reason = result.value.reason;
        entry.audienceId = result.value.audienceId;
        entry.audienceIds = result.value.audienceIds;
        entry.pages = result.value.pages;
      }
      if (signalsDue) {
        const result = await underOwnRun(orgId, brandId, userId, "apollo_buying_signal", "profile-signal-lists", (identity) =>
          ensureProfileSignalLists({
            orgId,
            brandId,
            offerId,
            userId,
            identity,
            originSlug: identity.workflowTracking?.featureSlug ?? null,
          }),
          (v) => v.some((o) => o.outcome === "failed")
        );
        if ("skip" in result) {
          entry.reason = entry.reason ?? result.skip;
          continue;
        }
        entry.signals = result.value;
        if (!engagementDue) {
          entry.action = result.value.some((o) => o.outcome === "created")
            ? "created"
            : result.value.some((o) => o.outcome === "failed")
              ? "failed"
              : "exists";
        }
      }
    }

    const result: CompetitorEngagementSweepResult = {
      dryRun,
      scanned: entries.length,
      created: entries.filter((e) => e.action === "created").length,
      entries,
    };
    console.log(
      `[human-service] competitor_engagement.sweep${dryRun ? "_dry_run" : ""} scanned=${result.scanned} created=${result.created} ${summarize(entries)}`
    );
    return result;
  } finally {
    sweeping = false;
  }
}

/** A profile still without a list for some buying signal (a below-threshold pair is re-measured: free). */
function signalTypesMissing(rows: AudienceRow[], profileId: string): boolean {
  const have = new Set(rows.filter((r) => r.profileAudienceId === profileId).map((r) => sourceKeyOf(r)));
  return BUYING_SIGNAL_TYPES.some((t) => !have.has(t));
}

/** The offer sources from buying signals: it was launched with a portfolio, or holds signal lists. */
async function offerUsesSignals(
  scope: { orgId: string; brandId: string; offerId: string },
  rows: AudienceRow[]
): Promise<boolean> {
  const hasList = rows.some((r) => {
    const k = sourceKeyOf(r);
    return k !== null && k !== "linkedin_engagement" && (r.status === "active" || r.status === "paused");
  });
  if (hasList) return true;
  const [portfolio] = await db
    .select({ id: audiencePortfolios.id })
    .from(audiencePortfolios)
    .where(
      and(
        eq(audiencePortfolios.orgId, scope.orgId),
        eq(audiencePortfolios.brandId, scope.brandId),
        eq(audiencePortfolios.offerId, scope.offerId)
      )
    )
    .limit(1);
  return !!portfolio;
}

/** Run `fn` under an org-billed run labelled with the list's sourcing origin. */
async function underOwnRun<T>(
  orgId: string,
  brandId: string,
  userId: string,
  list: "linkedin_engagement" | "apollo_buying_signal",
  taskName: string,
  fn: (identity: Identity) => Promise<T>,
  isFailed: (value: T) => boolean
): Promise<{ value: T } | { skip: string }> {
  let tracking: { brandIds: string[]; featureSlug: string };
  try {
    tracking = { brandIds: [brandId], featureSlug: await sourcingOriginSlug(list) };
  } catch (err) {
    const skip = `sourcing_origin_unresolved: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[human-service] competitor_engagement.sweep_origin_failed org=${orgId} brand=${brandId} ${skip}`);
    return { skip };
  }
  const runId = await createRun({ orgId, userId, taskName, workflowTracking: tracking });
  if (!runId) {
    console.error(`[human-service] competitor_engagement.sweep_run_failed org=${orgId} brand=${brandId} task=${taskName}`);
    return { skip: "run_failed" };
  }
  const value = await fn({ orgId, userId, runId, workflowTracking: tracking });
  await completeRun(runId, isFailed(value) ? "failed" : "completed", { orgId, userId, workflowTracking: tracking });
  return { value };
}

function summarize(entries: SweepEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
  return [...counts].map(([k, v]) => `${k}=${v}`).join(" ");
}

const DEFAULT_INITIAL_DELAY_MS = 15 * 60_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;

function readMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[human-service] competitor_engagement.bad_env ${name}=${raw} — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Arm the recurring sweep (timers only, first tick delayed: safe right after
 * `app.listen()`). `COMPETITOR_ENGAGEMENT_INTERVAL_MS=0` is the off switch.
 */
export function startCompetitorEngagementSweep(): () => void {
  const intervalMs = readMs("COMPETITOR_ENGAGEMENT_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  if (intervalMs === 0) {
    console.log("[human-service] competitor_engagement.disabled interval=0");
    return () => {};
  }
  const initialDelayMs = readMs("COMPETITOR_ENGAGEMENT_INITIAL_DELAY_MS", DEFAULT_INITIAL_DELAY_MS);
  console.log(`[human-service] competitor_engagement.armed initialDelayMs=${initialDelayMs} intervalMs=${intervalMs}`);
  const tick = () => {
    void runCompetitorEngagementSweep().catch((err) =>
      console.error("[human-service] competitor_engagement.sweep_failed", err)
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
