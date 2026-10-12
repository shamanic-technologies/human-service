// The per-brand re-contact window runs from the last REAL EMAIL, not only from
// the last serve (RECONTACT-LOOP-1011).
//
// Why: suppression is written when the gateway SERVES a person, and the window
// (3 months) was anchored there. But a serve and its email are separated by
// lead-service's sending queue — Perky's people were served 2026-07-01..07-11
// and emailed 07-16. instantly-service refuses a send inside 3 months of the
// previous SEND (409 `recent_brand_contact`), so between "serve + 3 months" and
// "send + 3 months" this gateway re-served people nobody can email, and the
// campaign looped on them. Measured 2026-10-12: every one of the 35,715
// (brand, person) pairs emailed in the last 3 months already HAD a suppression
// row (none missing), but 35,649 were anchored before their send and 4,613 were
// already servable again.
//
// What this does: copy every real `email_sent` fact from instantly-service's
// outreach fact feed (the owner of the send record, by cursor) onto
// `brand_suppressions`, per (org, atomic brand, email): `last_sent_at` records
// the send, and `last_served_at` — THE window anchor every read path uses
// (teaser filter, exclude-set, resolve-email block, claimServe, Remaining) — is
// moved to GREATEST(last_served_at, send). A person emailed but never served by
// this gateway (another path) gets a row dated from the send. Nothing about any
// read path changes, so there is still ONE window and one definition of it.
//
// Sends older than the window are skipped (they would suppress nobody). The
// cursor only advances in the same transaction as the page's writes, so a
// failed tick re-reads the same page. Idempotent: GREATEST never moves back.
//
// Boot safety: nothing here is awaited before `app.listen()`; timers only.

import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandSuppressions, suppressionSendSyncState } from "../db/schema.js";
import { getMigrationState } from "../lib/migration-state.js";
import { readOutreachFacts, SendFeedConfigError, type OutreachFact } from "../lib/instantly-sends.js";
import { normalizeEmail, windowCutoff } from "./suppression.js";

const FEED = "instantly-outreach-facts";
// Bounds one run; the next tick resumes from the cursor. The whole feed was
// ~200k facts (~200 pages) on 2026-10-12, so the first run catches up in one go.
const MAX_PAGES_PER_RUN = 400;
const WRITE_CHUNK = 2000;
const DEFAULT_INITIAL_DELAY_MS = 60_000;
const DEFAULT_INTERVAL_MS = 2 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SendSuppressionSyncResult {
  fromCursor: string;
  toCursor: string;
  pages: number;
  facts: number;
  sends: number;
  // Sends inside the window, deduped on (org, brand, email): rows written.
  applied: number;
  // Of `applied`, rows that did not exist (emailed, never served here).
  created: number;
  skippedOutsideWindow: number;
  skippedUnattributed: number;
  hasMore: boolean;
}

interface SendKey {
  orgId: string;
  brandId: string;
  emailNorm: string;
  sentAt: Date;
}

// Real sends of one page, inside the window, collapsed onto the latest send per
// (org, brand, email). Pure.
export function collectSends(
  facts: OutreachFact[],
  cutoff: Date
): { sends: number; keys: SendKey[]; outsideWindow: number; unattributed: number } {
  const byKey = new Map<string, SendKey>();
  let sends = 0;
  let outsideWindow = 0;
  let unattributed = 0;
  for (const f of facts) {
    if (f.type !== "email_sent") continue;
    sends += 1;
    const emailNorm = normalizeEmail(f.leadEmail);
    const sentAt = new Date(f.occurredAt);
    const brandIds = (f.brandIds ?? []).filter((b) => UUID_RE.test(b));
    // No org / brand / address: nothing a per-brand window can key on. Counted,
    // never invented.
    if (!f.orgId || !UUID_RE.test(f.orgId) || brandIds.length === 0 || !emailNorm || Number.isNaN(sentAt.getTime())) {
      unattributed += 1;
      continue;
    }
    if (sentAt <= cutoff) {
      outsideWindow += 1;
      continue;
    }
    for (const brandId of brandIds) {
      const k = `${f.orgId}|${brandId}|${emailNorm}`;
      const cur = byKey.get(k);
      if (!cur || cur.sentAt < sentAt) byKey.set(k, { orgId: f.orgId, brandId, emailNorm, sentAt });
    }
  }
  return { sends, keys: [...byKey.values()], outsideWindow, unattributed };
}

let running = false;

/** One catch-up run. Null when skipped (already running, schema not ready). */
export async function runSendSuppressionSync(): Promise<SendSuppressionSyncResult | null> {
  if (running) return null;
  if (getMigrationState() !== "ready") return null;
  running = true;
  try {
    const [state] = await db
      .select({ cursor: suppressionSendSyncState.cursor })
      .from(suppressionSendSyncState)
      .where(eq(suppressionSendSyncState.feed, FEED));
    let cursor = String(state?.cursor ?? 0);
    const result: SendSuppressionSyncResult = {
      fromCursor: cursor,
      toCursor: cursor,
      pages: 0,
      facts: 0,
      sends: 0,
      applied: 0,
      created: 0,
      skippedOutsideWindow: 0,
      skippedUnattributed: 0,
      hasMore: true,
    };

    while (result.pages < MAX_PAGES_PER_RUN) {
      const page = await readOutreachFacts(cursor);
      result.pages += 1;
      result.facts += page.facts.length;
      result.hasMore = page.hasMore;
      if (page.facts.length === 0) break;

      const [{ cutoff }] = (await db.execute(sql`select ${windowCutoff()} as cutoff`)) as unknown as {
        cutoff: Date | string;
      }[];
      const collected = collectSends(page.facts, new Date(cutoff));
      result.sends += collected.sends;
      result.skippedOutsideWindow += collected.outsideWindow;
      result.skippedUnattributed += collected.unattributed;

      const nextCursor = page.nextCursor;
      await db.transaction(async (tx) => {
        for (let i = 0; i < collected.keys.length; i += WRITE_CHUNK) {
          const chunk = collected.keys.slice(i, i + WRITE_CHUNK);
          const written = await tx
            .insert(brandSuppressions)
            .values(
              chunk.map((k) => ({
                orgId: k.orgId,
                brandId: k.brandId,
                emailNorm: k.emailNorm,
                // Emailed, never served by this gateway: the row is dated from
                // the send. Provider / pre-pay keys are unknown, never invented.
                firstServedAt: k.sentAt,
                lastServedAt: k.sentAt,
                lastSentAt: k.sentAt,
              }))
            )
            .onConflictDoUpdate({
              target: [brandSuppressions.orgId, brandSuppressions.brandId, brandSuppressions.emailNorm],
              set: {
                lastServedAt: sql`GREATEST(${brandSuppressions.lastServedAt}, excluded.last_served_at)`,
                lastSentAt: sql`GREATEST(${brandSuppressions.lastSentAt}, excluded.last_sent_at)`,
              },
            })
            .returning({ created: sql<boolean>`(xmax = 0)` });
          result.applied += written.length;
          result.created += written.filter((w) => w.created).length;
        }
        await tx
          .insert(suppressionSendSyncState)
          .values({ feed: FEED, cursor: Number(nextCursor) })
          .onConflictDoUpdate({
            target: suppressionSendSyncState.feed,
            set: { cursor: Number(nextCursor), updatedAt: sql`now()` },
          });
      });
      cursor = nextCursor;
      result.toCursor = cursor;
      if (!page.hasMore) break;
    }

    console.log(
      `[human-service] send_suppression_sync.run cursor=${result.fromCursor}->${result.toCursor} pages=${result.pages} sends=${result.sends} applied=${result.applied} created=${result.created} outsideWindow=${result.skippedOutsideWindow} unattributed=${result.skippedUnattributed} hasMore=${result.hasMore}`
    );
    return result;
  } finally {
    running = false;
  }
}

function readMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[human-service] send_suppression_sync.bad_env ${name}=${raw} — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Arm the recurring sync (timers only, never on the boot path). Every 2 min,
 * first tick 60s after boot. `SEND_SUPPRESSION_SYNC_INTERVAL_MS=0` is the off
 * switch. A failed tick logs loudly and the next one retries from the cursor.
 */
export function startSendSuppressionSync(): () => void {
  const intervalMs = readMs("SEND_SUPPRESSION_SYNC_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  if (intervalMs === 0) {
    console.log("[human-service] send_suppression_sync.disabled interval=0");
    return () => {};
  }
  const tick = () => {
    runSendSuppressionSync().catch((err) => {
      if (err instanceof SendFeedConfigError) {
        console.error(`[human-service] send_suppression_sync.unconfigured ${err.message}`);
        return;
      }
      console.error("[human-service] send_suppression_sync.failed", err);
    });
  };
  const timers: NodeJS.Timeout[] = [];
  const first = setTimeout(() => {
    tick();
    const repeat = setInterval(tick, intervalMs);
    repeat.unref?.();
    timers.push(repeat);
  }, readMs("SEND_SUPPRESSION_SYNC_INITIAL_DELAY_MS", DEFAULT_INITIAL_DELAY_MS));
  first.unref?.();
  timers.push(first);
  return () => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  };
}
