// MON-PAGE-SPEED-FLOOR-1120: the brand audience snapshot reads (totals, people
// page, companies page) answer from their LAST COMPUTED body, stored in
// audience_snapshot_cache, and compute a fresh one behind the answer when the
// stored one is older than SNAPSHOT_FRESH_MS. A dashboard reload is then one
// primary-key read (a few ms) instead of the whole held-people aggregation
// (0.5-4 s on a 205-audience brand under the box's load, 2026-11-20).
//
// - Same body: what is stored is the exact JSON the computation returned (text,
//   key order kept), so a cached answer is byte-identical to the computed one it
//   copies. The figures are at most one refresh old.
// - Scope: the key is brand + org scope (the `orgId` query, "-" when absent) +
//   read + page args, so one brand's or org's answer is never served to another.
// - First read of a key (never computed) computes inline, stores, answers.
// - A refresh failure keeps the stored body and logs loud; the next read retries.
// - One refresh per key at a time in this process (in-flight map).
// - AUDIENCE_SNAPSHOT_CACHE=off answers every read inline (tests default to off,
//   tests/setup.ts: suites write rows and read them back at once).
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export const SNAPSHOT_FRESH_MS = 60_000;

export interface SnapshotCacheKey {
  brandId: string;
  orgId?: string;
  read: "totals" | "people" | "companies";
  args?: Record<string, string | number | boolean>;
}

export function snapshotCacheKey(k: SnapshotCacheKey): string {
  const args = Object.keys(k.args ?? {})
    .sort()
    .map((name) => `${name}=${String(k.args![name])}`)
    .join("&");
  return `${k.brandId}|${k.orgId ?? "-"}|${k.read}|${args}`;
}

function enabled(): boolean {
  return process.env.AUDIENCE_SNAPSHOT_CACHE !== "off";
}

const inFlight = new Map<string, Promise<unknown>>();

async function computeAndStore<T>(key: SnapshotCacheKey, cacheKey: string, compute: () => Promise<T>): Promise<T> {
  const body = await compute();
  await db.execute(sql`
    insert into audience_snapshot_cache (cache_key, brand_id, org_id, body, computed_at)
    values (${cacheKey}, ${key.brandId}, ${key.orgId ?? null}, ${JSON.stringify(body)}, now())
    on conflict (cache_key) do update set body = excluded.body, computed_at = excluded.computed_at`);
  return body;
}

function refreshOnce<T>(key: SnapshotCacheKey, cacheKey: string, compute: () => Promise<T>): Promise<T> {
  const running = inFlight.get(cacheKey);
  if (running) return running as Promise<T>;
  const p = computeAndStore(key, cacheKey, compute).finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, p);
  return p;
}

export async function cachedSnapshotRead<T>(key: SnapshotCacheKey, compute: () => Promise<T>): Promise<T> {
  if (!enabled()) return compute();
  const cacheKey = snapshotCacheKey(key);
  const [row] = (await db.execute(sql`
    select body, extract(epoch from (now() - computed_at)) * 1000 as age_ms
    from audience_snapshot_cache where cache_key = ${cacheKey}`)) as unknown as Array<{ body: string; age_ms: string | number }>;
  if (!row) return refreshOnce(key, cacheKey, compute);
  if (Number(row.age_ms) > SNAPSHOT_FRESH_MS) {
    refreshOnce(key, cacheKey, compute).catch((err) =>
      console.error("[audience_snapshot.refresh_failed]", cacheKey, err)
    );
  }
  return JSON.parse(row.body) as T;
}

// Tests: wait for every background refresh this process started.
export async function settleSnapshotRefreshes(): Promise<void> {
  await Promise.allSettled([...inFlight.values()]);
}
