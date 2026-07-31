import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index.js";
import {
  markMigrationsFailed,
  markMigrationsPending,
  markMigrationsReady,
} from "../lib/migration-state.js";
import { describeError, isTransientConnectError, sleep } from "../lib/transient-connect.js";

export { isTransientConnectError };

const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000, 15_000];

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
        markMigrationsFailed(describeError(err));
        return;
      }

      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        console.error(
          `[human-service] Migration FAILED: database still unreachable after ${attempt + 1} attempts:`,
          err
        );
        markMigrationsFailed(describeError(err));
        return;
      }

      console.warn(
        `[human-service] Database not reachable yet (attempt ${attempt + 1}, ${describeError(err)}) — ` +
          `likely a suspended Neon compute resuming; retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
}
