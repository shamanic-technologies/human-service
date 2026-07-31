/**
 * Boot-time schema readiness — the LIVE vs READY split.
 *
 * The port binds BEFORE migrations run. Railway's healthcheck window is 30s and
 * a suspended Neon compute can spend all of it resuming, so awaiting `migrate()`
 * before `app.listen()` meant a deploy landing on a cold compute never opened
 * the port and was marked FAILED (observed on staging 2026-07-30). Binding first
 * makes the process LIVE immediately, which leaves a window where it is live but
 * its schema is not yet migrated. This module holds that state so:
 *
 *   - `/health` can answer 200 while migrations are still running (deploy passes),
 *   - every other route answers 503 until they land (no traffic is ever served
 *     against a schema the code does not expect),
 *   - a genuine migration failure is terminal and visible, never swallowed.
 *
 * The default is `"ready"`: the gate is ARMED explicitly by the boot sequence
 * (`markMigrationsPending`). Tests and any other embedded use of `app` bring up
 * their own schema and are never gated by a state machine they never started.
 */

export type MigrationState = "ready" | "pending" | "failed";

let state: MigrationState = "ready";
let failureMessage: string | null = null;

export function getMigrationState(): MigrationState {
  return state;
}

/** The error that made migrations terminal, for the 503 body. Null unless failed. */
export function getMigrationFailure(): string | null {
  return failureMessage;
}

export function markMigrationsPending(): void {
  state = "pending";
  failureMessage = null;
}

export function markMigrationsReady(): void {
  state = "ready";
  failureMessage = null;
}

export function markMigrationsFailed(message: string): void {
  state = "failed";
  failureMessage = message;
}
