// The "engaged with competitor posts" audience, created BY US for every client
// brand (owner 2026-10-03: "c'est à nous de gérer nos audiences, on est censé
// connaître les competitors de notre client et leurs LinkedIn"). No client input.
//
// What: one linkedin_engagement signal audience (linkedin-engagement-audience.ts)
// per (org, brand, offer), built from up to 3 competitor LinkedIn company pages
// brand-service found (src/lib/brand-competitors.ts). Born ACTIVE so campaigns
// test it against the other audiences. Its screen target (`nl_prompt`) is the
// ICP target the brand's other audiences already use.
//
// When:
//   - at portfolio launch (audience-portfolio.ts, background phase);
//   - on the recurring sweep (runCompetitorEngagementSweep, same tick as the
//     refill) for every brand with an active audience whose billing can charge
//     it: existing brands, and brands whose competitors were not computed yet.
//
// Outcomes, each logged with its reason:
//   created       one audience created
//   exists        the scope already holds one (any status): never duplicated
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

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences } from "../db/schema.js";
import { discoverBrandCompetitors, type BrandCompetitor } from "../lib/brand-competitors.js";
import { canBeCharged, getPaymentOutlook } from "../lib/billing-outlook.js";
import { getMigrationState } from "../lib/migration-state.js";
import { dedupeSegmentNames, pickOffer } from "./audience-refill.js";
import { createLinkedinEngagementAudience } from "./linkedin-engagement-audience.js";
import type { Identity } from "./people-providers.js";
import { completeRun, createRun } from "./runs.js";

/** apollo-service accepts 1-3 competitor pages per audience. */
export const MAX_COMPETITOR_PAGES = 3;
/** Age of the competitor posts whose engagers are served (rolling). A like or a
 * comment is a fresh, short-lived sign of interest: one month. */
export const COMPETITOR_ENGAGEMENT_WINDOW_DAYS = 30;
export const COMPETITOR_ENGAGEMENT_NAME = "Engaged with competitor posts";

export type CompetitorEngagementOutcomeKind = "created" | "exists" | "no_pages" | "not_computed" | "failed";

export interface CompetitorEngagementOutcome {
  orgId: string;
  brandId: string;
  offerId: string | null;
  outcome: CompetitorEngagementOutcomeKind;
  audienceId: string | null;
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

/** The scope's existing linkedin_engagement audience, any status, any source. */
async function findExisting(orgId: string, brandId: string, offerId: string | null) {
  const [row] = await db
    .select({ id: audiences.id })
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, orgId),
        eq(audiences.brandId, brandId),
        offerId ? eq(audiences.offerId, offerId) : sql`${audiences.offerId} is null`,
        sql`${audiences.filters}->'buying_signal'->>'type' = 'linkedin_engagement'`
      )
    )
    .limit(1);
  return row ?? null;
}

const inFlight = new Map<string, Promise<CompetitorEngagementOutcome>>();

/**
 * Create the scope's competitor-engagement audience unless it already has one.
 * Never throws: every failure is the `failed` outcome, logged loud.
 */
export async function ensureCompetitorEngagementAudience(args: {
  orgId: string;
  userId: string;
  brandId: string;
  offerId: string | null;
  target: string;
  identity: Identity;
}): Promise<CompetitorEngagementOutcome> {
  const key = `${args.orgId}:${args.brandId}:${args.offerId ?? "-"}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = ensureOnce(args).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function ensureOnce(args: {
  orgId: string;
  userId: string;
  brandId: string;
  offerId: string | null;
  target: string;
  identity: Identity;
}): Promise<CompetitorEngagementOutcome> {
  const out: CompetitorEngagementOutcome = {
    orgId: args.orgId,
    brandId: args.brandId,
    offerId: args.offerId,
    outcome: "failed",
    audienceId: null,
    pages: [],
    reason: null,
  };
  const done = (o: Partial<CompetitorEngagementOutcome>): CompetitorEngagementOutcome => {
    Object.assign(out, o);
    const line = `[human-service] competitor_engagement.${out.outcome} org=${out.orgId} brand=${out.brandId} offer=${out.offerId ?? "-"} audience=${out.audienceId ?? "-"} pages=${out.pages.length}${out.reason ? ` reason=${JSON.stringify(out.reason)}` : ""}`;
    if (out.outcome === "failed") console.error(line);
    else console.log(line);
    return out;
  };

  try {
    const existing = await findExisting(args.orgId, args.brandId, args.offerId);
    if (existing) return done({ outcome: "exists", audienceId: existing.id });

    const answer = await discoverBrandCompetitors(args.brandId, args.identity);
    if (answer.status === "not_computed") return done({ outcome: "not_computed", reason: answer.reason });
    const pages = pickCompetitorPages(answer.competitors);
    if (pages.length === 0) {
      return done({
        outcome: "no_pages",
        reason:
          answer.competitors.length === 0
            ? "brand-service found no competitor"
            : `none of the ${answer.competitors.length} competitors links a LinkedIn company page`,
      });
    }

    // Re-check after the (possibly slow) discovery: a concurrent path may have
    // created it meanwhile.
    const raced = await findExisting(args.orgId, args.brandId, args.offerId);
    if (raced) return done({ outcome: "exists", audienceId: raced.id, pages });

    const taken = await db
      .select({ name: audiences.name })
      .from(audiences)
      .where(and(eq(audiences.orgId, args.orgId), eq(audiences.brandId, args.brandId)));
    const [name] = dedupeSegmentNames([COMPETITOR_ENGAGEMENT_NAME], taken.map((t) => t.name));
    const row = await createLinkedinEngagementAudience({
      orgId: args.orgId,
      userId: args.userId,
      brandId: args.brandId,
      offerId: args.offerId,
      name,
      nlPrompt: args.target,
      status: "active",
      windowDays: COMPETITOR_ENGAGEMENT_WINDOW_DAYS,
      competitorPages: pages,
      baseFilters: {},
      identity: { ...args.identity, brandIds: [args.brandId] },
    });
    return done({ outcome: "created", audienceId: row.id, pages });
  } catch (err) {
    return done({ outcome: "failed", reason: err instanceof Error ? err.message : String(err) });
  }
}

// --- Sweep: existing brands, and brands whose competitors were not ready ---

export type SweepSkipReason = "not_chargeable" | "billing_unreadable" | "no_offer" | "no_target" | "no_user" | "run_failed";

export interface SweepEntry {
  orgId: string;
  brandId: string;
  offerId: string | null;
  action: CompetitorEngagementOutcomeKind | "would_ensure" | "skipped";
  reason: string | null;
  audienceId: string | null;
  pages: string[];
}

export interface CompetitorEngagementSweepResult {
  dryRun: boolean;
  scanned: number;
  created: number;
  entries: SweepEntry[];
}

let sweeping = false;

/**
 * For every (org, brand) holding an ACTIVE audience and no competitor-engagement
 * audience on its main offer yet: when billing can charge the org, ensure one.
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
      const entry: SweepEntry = { orgId, brandId, offerId, action: "skipped", reason: null, audienceId: null, pages: [] };
      entries.push(entry);
      if (!offerId) {
        entry.reason = "no_offer";
        continue;
      }
      const existing = await findExisting(orgId, brandId, offerId);
      if (existing) {
        entry.action = "exists";
        entry.audienceId = existing.id;
        continue;
      }
      const inOffer = rows.filter((a) => a.offerId === offerId);
      const target = inOffer.find((a) => a.nlPrompt?.trim())?.nlPrompt?.trim() ?? null;
      if (!target) {
        entry.reason = "no_target";
        continue;
      }
      const userId = inOffer.find((a) => a.createdByUserId)?.createdByUserId ?? null;
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

      const tracking = { brandIds: [brandId] };
      const runId = await createRun({ orgId, userId, taskName: "competitor-engagement-audience", workflowTracking: tracking });
      if (!runId) {
        entry.reason = "run_failed";
        console.error(`[human-service] competitor_engagement.sweep_run_failed org=${orgId} brand=${brandId}`);
        continue;
      }
      const result = await ensureCompetitorEngagementAudience({
        orgId,
        userId,
        brandId,
        offerId,
        target,
        identity: { orgId, userId, runId, workflowTracking: tracking },
      });
      await completeRun(runId, result.outcome === "failed" ? "failed" : "completed", {
        orgId,
        userId,
        workflowTracking: tracking,
      });
      entry.action = result.outcome;
      entry.reason = result.reason;
      entry.audienceId = result.audienceId;
      entry.pages = result.pages;
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
