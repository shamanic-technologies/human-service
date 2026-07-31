import { Router } from "express";
import { getMigrationState } from "../lib/migration-state.js";

const router = Router();

router.get("/health", (_req, res) => {
  const migrations = getMigrationState();

  // `pending` answers 200 on purpose. The port binds before migrations run, and
  // Railway's healthcheck window is only 30s — a suspended Neon compute can take
  // longer than that to resume, which is exactly the deploy failure this route
  // exists to survive. It is not a lie about readiness: every DB-backed route is
  // held at 503 by `requireMigratedSchema` until migrations land, so a `pending`
  // 200 can never mean traffic is being served against an un-migrated schema.
  //
  // `failed` answers 503 — a migration that genuinely could not run must be
  // loud, and the service must not look healthy while it serves nothing.
  const failed = migrations === "failed";
  res.status(failed ? 503 : 200).json({
    status: failed ? "error" : "ok",
    service: "human",
    migrations,
  });
});

export default router;
