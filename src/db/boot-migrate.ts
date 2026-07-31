import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index.js";
import {
  markMigrationsFailed,
  markMigrationsPending,
  markMigrationsReady,
} from "../lib/migration-state.js";

/**
 * Codes that mean "the database was not reachable yet", i.e. the migration never
 * started running. A Neon compute suspended by scale-to-zero takes seconds to
 * resume and rejects (or stalls then resets) the first connection attempts, so
 * these are expected on a deploy that lands cold — retrying is the whole point.
 *
 * Everything NOT in this set is treated as a real migration failure: terminal,
 * loud, never retried.
 */
const TRANSIENT_CONNECT_CODES = new Set([
  // Node socket / DNS layer
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  // postgres.js client-side connection errors
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECTION_REFUSED",
  // Postgres SQLSTATE class 08 (connection exception) + a resuming/saturated compute
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P03", // cannot_connect_now — the server is starting up
  "53300", // too_many_connections
]);

/**
 * Message fragments postgres.js / pg surface without a machine-readable code.
 * Kept narrow on purpose: a wide regex here would swallow a real schema error.
 */
const TRANSIENT_MESSAGE_RE =
  /connect\s+(?:etimedout|econnrefused|econnreset)|timeout expired|timeout exceeded when trying to connect|connection terminated|write connection_closed|the database system is starting up|could not connect/i;

const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000, 15_000];

/**
 * True when `err` (or anything in its `cause` chain / `AggregateError.errors`)
 * is a connect-phase failure. Node's happy-eyeballs wraps per-address failures
 * in an `AggregateError`, and `fetch`/postgres.js nest the real cause, so a flat
 * `err.code` check misses the common shapes.
 */
export function isTransientConnectError(err: unknown, seen = new Set<unknown>()): boolean {
  if (err === null || typeof err !== "object" || seen.has(err)) return false;
  seen.add(err);

  const candidate = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };

  if (typeof candidate.code === "string" && TRANSIENT_CONNECT_CODES.has(candidate.code)) {
    return true;
  }
  if (typeof candidate.message === "string" && TRANSIENT_MESSAGE_RE.test(candidate.message)) {
    return true;
  }
  if (Array.isArray(candidate.errors) && candidate.errors.some((e) => isTransientConnectError(e, seen))) {
    return true;
  }
  return isTransientConnectError(candidate.cause, seen);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run drizzle migrations AFTER the port is already open.
 *
 * Never throws and never exits the process: the container exiting is exactly the
 * crash-loop this exists to remove. Outcomes are all expressed as state:
 *
 *   - success            → `ready`,  routes open.
 *   - DB not reachable   → retried with backoff (~76s total) while `pending`,
 *                          so a cold Neon compute resumes on its own; only on
 *                          exhaustion does it become `failed`.
 *   - real SQL/schema error → `failed` immediately, logged loudly, no retry.
 *
 * `failed` means every route except `/health` answers 503 and `/health` itself
 * reports unhealthy — loud and visible, and traffic is never served against a
 * schema the code does not expect.
 */
export async function runMigrationsOnBoot(): Promise<void> {
  markMigrationsPending();

  for (let attempt = 0; ; attempt++) {
    try {
      await migrate(db, { migrationsFolder: "./drizzle" });
      markMigrationsReady();
      console.log("[human-service] Migrations complete");
      return;
    } catch (err) {
      if (!isTransientConnectError(err)) {
        console.error("[human-service] Migration FAILED (not a connection error — not retrying):", err);
        markMigrationsFailed(describe(err));
        return;
      }

      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        console.error(
          `[human-service] Migration FAILED: database still unreachable after ${attempt + 1} attempts:`,
          err
        );
        markMigrationsFailed(describe(err));
        return;
      }

      console.warn(
        `[human-service] Database not reachable yet (attempt ${attempt + 1}, ${describe(err)}) — ` +
          `likely a suspended Neon compute resuming; retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
}
