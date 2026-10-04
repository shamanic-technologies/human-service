// ONE text per audience (`audiences.target_text`): who the customer wants for
// THIS audience. It is what the dashboard shows as the audience and what the
// pre-pay screen judges every candidate against, so what the client reads is
// what Jev qualifies leads on.
//
// WHY NOT nl_prompt. A split stores the SAME nl_prompt on every sibling (the
// whole target it was split from), so "Managing Partners", "Solo Practitioners"
// and "Legal Administrators" at the same firms were all screened against
// "Managing Partners, Solo Practitioners and Legal Administrators at ...". The
// screen could not tell the three apart.
//
// WHY NOT description. On older rows it describes how the Apollo filters were
// built ("found by matching terms against company tags"); the v1 screen judged
// against it and passed 199/285 on LivingVital, ~51 of them HQ staff.
//
// THE RULE, one everywhere (write time, serve time, backfill):
//   - An audience that is ONE OF SEVERAL sharing its nl_prompt (same org +
//     brand, not deprecated) and that carries its own segment sentence gets a
//     SEGMENT target: drafted from the shared target + its segment sentence
//     (audience-target.ts), origin 'segment_target'.
//   - Every other audience is not one of several: its nl_prompt already IS its
//     text, copied verbatim, origin 'audience_target'. That includes buying
//     signal and linkedin_engagement audiences: they reach the WHOLE target
//     through a different list, and their description says how the list is
//     built (a signal), not who is wanted.
//   - No nl_prompt at all ⟹ no text (null), stated as `no_customer_text`.

import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences } from "../db/schema.js";
import type { ChatIdentity } from "../lib/chat-client.js";
import {
  draftSegmentTarget,
  draftSegmentTargetOnPlatform,
  offersForSegment,
} from "./audience-target.js";

type AudienceRow = typeof audiences.$inferSelect;

export const TARGET_TEXT_ORIGINS = ["segment_target", "audience_target"] as const;
export type TargetTextOrigin = (typeof TARGET_TEXT_ORIGINS)[number];

/** Why an audience serves no target text. */
export type TargetTextMissingReason = "no_customer_text" | "not_written_yet";

/** The fields an insert sets for an audience that is not one of several. */
export function audienceTargetFields(nlPrompt: string | null | undefined): {
  targetText: string | null;
  targetTextOrigin: TargetTextOrigin | null;
} {
  const text = nlPrompt?.trim() || null;
  return { targetText: text, targetTextOrigin: text ? "audience_target" : null };
}

/** True when the stored (opaque) filters carry a buying signal of any kind. */
export function hasBuyingSignal(filters: unknown): boolean {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return false;
  const signal = (filters as Record<string, unknown>).buying_signal;
  return !!signal && typeof signal === "object";
}

export function targetTextMissingReason(
  row: Pick<AudienceRow, "targetText" | "nlPrompt">
): TargetTextMissingReason | null {
  if (row.targetText) return null;
  return row.nlPrompt?.trim() ? "not_written_yet" : "no_customer_text";
}

/**
 * What the screen judges this audience's candidates against. `target_text`
 * whenever it is written; until then the audience's nl_prompt, and the bronze
 * row records WHICH field was used, so a verdict judged on the shared text is
 * visible as such. Null ⟹ nothing to judge against (no customer text).
 */
export function screenTarget(
  row: Pick<AudienceRow, "targetText" | "nlPrompt">
): { text: string; field: "target_text" | "nl_prompt" } | null {
  const own = row.targetText?.trim();
  if (own) return { text: own, field: "target_text" };
  const shared = row.nlPrompt?.trim();
  if (shared) return { text: shared, field: "nl_prompt" };
  return null;
}

/** Does this audience share its nl_prompt with another live audience of its brand? */
async function hasSiblingSharingPrompt(row: AudienceRow): Promise<boolean> {
  if (!row.nlPrompt?.trim()) return false;
  const [hit] = await db
    .select({ id: audiences.id })
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, row.orgId),
        eq(audiences.brandId, row.brandId),
        ne(audiences.id, row.id),
        eq(audiences.nlPrompt, row.nlPrompt),
        ne(audiences.status, "deprecated")
      )
    )
    .limit(1);
  return !!hit;
}

/** The segment the audience covers, when the rule says it gets a segment target. */
async function segmentOf(row: AudienceRow): Promise<{ name: string; description: string } | null> {
  const description = row.description?.trim();
  if (!description || hasBuyingSignal(row.filters)) return null;
  return (await hasSiblingSharingPrompt(row)) ? { name: row.name, description } : null;
}

async function storeTargetText(
  id: string,
  targetText: string | null,
  origin: TargetTextOrigin | null
): Promise<void> {
  // Only a row still without a text: a concurrent writer that got there first
  // wins, and an existing text is never silently replaced.
  await db
    .update(audiences)
    .set({ targetText, targetTextOrigin: origin, updatedAt: new Date() })
    .where(and(eq(audiences.id, id), isNull(audiences.targetText)));
}

const inFlight = new Map<string, Promise<string | null>>();

// The stored text, read back: a concurrent writer may have stored first.
async function readTargetText(id: string): Promise<string | null> {
  const [row] = await db
    .select({ targetText: audiences.targetText })
    .from(audiences)
    .where(eq(audiences.id, id));
  return row?.targetText ?? null;
}

/**
 * Write the audience's text if it has none. Deduped per audience through one
 * in-flight promise, so the background call after a confirm and the inline call
 * on serve-next never pay twice. Org-billed with the caller's identity (chat-
 * service owns the cost). Fail loud: a draft failure propagates.
 */
export function ensureTargetText(
  row: AudienceRow,
  identity: ChatIdentity
): Promise<string | null> {
  if (row.targetText) return Promise.resolve(row.targetText);
  if (!row.nlPrompt?.trim()) return Promise.resolve(null);
  const pending = inFlight.get(row.id);
  if (pending) return pending;
  const p = (async () => {
    const segment = await segmentOf(row);
    if (!segment) {
      const fields = audienceTargetFields(row.nlPrompt);
      await storeTargetText(row.id, fields.targetText, fields.targetTextOrigin);
      return readTargetText(row.id);
    }
    const text = await draftSegmentTarget({
      sharedTarget: row.nlPrompt!.trim(),
      segment,
      brandId: row.brandId,
      offerId: row.offerId,
      identity: { ...identity, orgId: row.orgId },
    });
    await storeTargetText(row.id, text, "segment_target");
    console.log(
      `[human-service] audience.target_text_written org=${row.orgId} audience=${row.id} origin=segment_target text=${JSON.stringify(text)}`
    );
    return readTargetText(row.id);
  })().finally(() => inFlight.delete(row.id));
  inFlight.set(row.id, p);
  return p;
}

// --- Backfill: rows that predate target_text --------------------------------

export interface TargetTextBackfillResult {
  dryRun: boolean;
  scanned: number;
  /** Rows whose nl_prompt is copied as their text (not one of several). */
  audienceTarget: number;
  /** Rows that get a drafted segment target. */
  segmentTarget: number;
  /** Rows with no customer text at all: served as null, reason no_customer_text. */
  noCustomerText: number;
  failed: Array<{ audienceId: string; error: string }>;
  sample: Array<{ audienceId: string; name: string; origin: TargetTextOrigin; targetText: string | null }>;
}

const BACKFILL_CONCURRENCY = 6;

/**
 * One-time sweep over every non-deprecated audience without a text. Idempotent
 * (scoped to target_text IS NULL), dry-runnable (`dryRun` classifies and drafts
 * nothing). Segment targets go through chat-service's platform path: a text we
 * owe existing audiences must not bill their orgs. A row whose draft fails is
 * counted and left null (retried on a re-run, and drafted inline on its next
 * serve); the sweep carries on.
 */
export async function backfillTargetTexts(opts: {
  dryRun: boolean;
  brandId?: string;
  sampleSize?: number;
}): Promise<TargetTextBackfillResult> {
  const conditions = [isNull(audiences.targetText), ne(audiences.status, "deprecated")];
  if (opts.brandId) conditions.push(eq(audiences.brandId, opts.brandId));
  const rows = await db.select().from(audiences).where(and(...conditions));

  const result: TargetTextBackfillResult = {
    dryRun: opts.dryRun,
    scanned: rows.length,
    audienceTarget: 0,
    segmentTarget: 0,
    noCustomerText: 0,
    failed: [],
    sample: [],
  };
  const sampleSize = opts.sampleSize ?? 20;
  const offersCache = new Map<string, Promise<Awaited<ReturnType<typeof offersForSegment>>>>();

  const work = rows.map((row) => async () => {
    if (!row.nlPrompt?.trim()) {
      result.noCustomerText++;
      return;
    }
    const segment = await segmentOf(row);
    if (!segment) {
      result.audienceTarget++;
      const fields = audienceTargetFields(row.nlPrompt);
      if (!opts.dryRun) await storeTargetText(row.id, fields.targetText, fields.targetTextOrigin);
      if (result.sample.length < sampleSize) {
        result.sample.push({ audienceId: row.id, name: row.name, origin: "audience_target", targetText: fields.targetText });
      }
      return;
    }
    result.segmentTarget++;
    if (opts.dryRun) {
      if (result.sample.length < sampleSize) {
        result.sample.push({ audienceId: row.id, name: row.name, origin: "segment_target", targetText: null });
      }
      return;
    }
    try {
      const key = `${row.orgId}:${row.brandId}:${row.offerId ?? ""}`;
      if (!offersCache.has(key)) offersCache.set(key, offersForSegment(row.brandId, row.orgId, row.offerId));
      const offers = await offersCache.get(key)!;
      const text = await draftSegmentTargetOnPlatform({
        sharedTarget: row.nlPrompt.trim(),
        segment,
        offers,
      });
      await storeTargetText(row.id, text, "segment_target");
      if (result.sample.length < sampleSize) {
        result.sample.push({ audienceId: row.id, name: row.name, origin: "segment_target", targetText: text });
      }
    } catch (err) {
      result.segmentTarget--;
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ audienceId: row.id, error });
      console.error(`[human-service] audience.target_text_backfill.failed audience=${row.id} ${error}`);
    }
  });

  for (let i = 0; i < work.length; i += BACKFILL_CONCURRENCY) {
    await Promise.all(work.slice(i, i + BACKFILL_CONCURRENCY).map((fn) => fn()));
  }
  console.log(
    `[human-service] audience.target_text_backfill dryRun=${opts.dryRun} scanned=${result.scanned} audience_target=${result.audienceTarget} segment_target=${result.segmentTarget} no_customer_text=${result.noCustomerText} failed=${result.failed.length}`
  );
  return result;
}
