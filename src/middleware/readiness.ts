import type { Request, Response, NextFunction } from "express";
import { getMigrationFailure, getMigrationState } from "../lib/migration-state.js";

/**
 * Liveness surfaces stay reachable while the schema is still being migrated:
 * Railway healthchecks `/health`, and `/openapi.json` is a static artifact that
 * touches no table.
 */
const ALWAYS_ALLOWED = new Set(["/health", "/openapi.json"]);

/**
 * Gate every DB-backed route on migrations having landed.
 *
 * `app.listen()` now runs before `migrate()` (see `lib/migration-state.ts`), so
 * without this gate a request arriving during a cold Neon resume would hit an
 * un-migrated schema. 503 + `Retry-After` is the honest answer: the service is
 * starting, not broken. A terminal migration failure keeps returning 503 too —
 * we never quietly serve traffic against a schema the code does not expect.
 */
export function requireMigratedSchema(req: Request, res: Response, next: NextFunction): void {
  // Express routes `/health/` to the `/health` handler by default (non-strict
  // routing), so the allowlist has to see them as the same path too — otherwise
  // a caller with a trailing slash gets gated off the one route that must never
  // be gated.
  const path = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
  if (ALWAYS_ALLOWED.has(path)) {
    next();
    return;
  }

  const state = getMigrationState();
  if (state === "ready") {
    next();
    return;
  }

  res.setHeader("Retry-After", "5");
  if (state === "pending") {
    res.status(503).json({ error: "Service starting: database migrations are still running" });
    return;
  }

  res.status(503).json({
    error: `Service unavailable: database migrations failed: ${getMigrationFailure() ?? "unknown error"}`,
  });
}
