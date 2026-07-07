import express from "express";
import cors from "cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
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
app.use(listsRoutes);
app.use(peopleRoutes);
app.use(audiencesRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(async () => {
      console.log("[human-service] Migrations complete");
      await runInstrumentation();
      app.listen(Number(PORT), "::", () => {
        console.log(`[human-service] Running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("[human-service] Migration failed:", err);
      process.exit(1);
    });
}

export default app;
