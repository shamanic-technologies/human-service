import express from "express";
import cors from "cors";
import { runMigrationsOnBoot } from "./db/boot-migrate.js";
import { requireMigratedSchema } from "./middleware/readiness.js";
import healthRoutes from "./routes/health.js";
import openapiRoutes from "./routes/openapi.js";
import humanRoutes from "./routes/humans.js";
import methodologyRoutes from "./routes/methodology.js";
import transferBrandRoutes from "./routes/transfer-brand.js";
import backfillRoutes from "./routes/backfill.js";
import listsRoutes from "./routes/lists.js";
import peopleRoutes from "./routes/people.js";
import audiencesRoutes from "./routes/audiences.js";
import internalAudiencesRoutes from "./routes/internal-audiences.js";
import suppressionRecoveryRoutes from "./routes/suppression-recovery.js";
import { register as runInstrumentation } from "./instrumentation.js";

// Process-level safety net: a single request must NEVER crash-loop the whole
// service. Before this, an unawaited async rejection (e.g. a bad `uuid` param →
// Postgres 22P02) bubbled up as an unhandled rejection and Node exited → Railway
// restart loop → human-service DOWN for every consumer. Log loudly (fail-loud on
// the individual failure) but keep serving; per-request errors still surface as
// 4xx/5xx via the normal handler + validation path.
process.on("unhandledRejection", (reason) => {
  console.error("[human-service] Unhandled promise rejection (process kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[human-service] Uncaught exception (process kept alive):", err);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// Migrations run AFTER the port is open (see below), so every DB-backed route is
// held at 503 until they land. `/health` and `/openapi.json` pass through.
app.use(requireMigratedSchema);
// Internal bulk audience resolver mounts BEFORE the global 100 KB json parser so
// its own 25 MB parser handles lead-service's large payloads; the global parser
// then no-ops on those (body already parsed). Org-scoped routes keep the 100 KB
// browser guard.
app.use(internalAudiencesRoutes);
app.use(express.json());

app.use(healthRoutes);
app.use(openapiRoutes);
app.use(humanRoutes);
app.use(methodologyRoutes);
app.use(transferBrandRoutes);
app.use(backfillRoutes);
app.use(suppressionRecoveryRoutes);
app.use(listsRoutes);
app.use(peopleRoutes);
app.use(audiencesRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

if (process.env.NODE_ENV !== "test") {
  // BIND THE PORT FIRST. Everything that touches the network — `migrate()` on a
  // Neon compute that may be suspended, and the key-service registration — used
  // to be awaited here, so a deploy landing on a cold compute spent its whole
  // startup budget on the first DB connection, never opened the port inside
  // Railway's 30s healthcheck window, and was marked FAILED (or rejected and
  // `process.exit(1)`'d into a restart loop). Neither had anything to do with
  // the code being deployed. With the port open first, a slow resume costs a few
  // seconds of 503s on DB-backed routes instead of a failed deploy.
  app.listen(Number(PORT), "::", () => {
    console.log(`[human-service] Running on port ${PORT}`);
  });

  // Off the critical path, both fail-loud in their own way: migrations gate every
  // DB-backed route (503 until ready, 503 forever + unhealthy /health if they
  // genuinely fail), and a failed platform-key registration is logged, not fatal.
  void runMigrationsOnBoot();
  runInstrumentation().catch((err) => {
    console.error("[human-service] Platform-key registration failed:", err);
  });
}

export default app;
