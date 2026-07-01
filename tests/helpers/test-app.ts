import express from "express";
import cors from "cors";
import healthRoutes from "../../src/routes/health.js";
import openapiRoutes from "../../src/routes/openapi.js";
import humanRoutes from "../../src/routes/humans.js";
import methodologyRoutes from "../../src/routes/methodology.js";
import transferBrandRoutes from "../../src/routes/transfer-brand.js";
import backfillRoutes from "../../src/routes/backfill.js";
import listsRoutes from "../../src/routes/lists.js";
import peopleRoutes from "../../src/routes/people.js";
import audiencesRoutes from "../../src/routes/audiences.js";
import internalAudiencesRoutes from "../../src/routes/internal-audiences.js";

export function createTestApp() {
  const app = express();
  app.use(cors());
  // Mirror index.ts: internal resolver (25 MB parser) mounts before the global
  // 100 KB json parser.
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

  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

export function getAuthHeaders() {
  return {
    "X-API-Key": "test-api-key",
    "Content-Type": "application/json",
    "x-org-id": "00000000-0000-0000-0000-000000000001",
    "x-user-id": "00000000-0000-0000-0000-000000000002",
    "x-run-id": "00000000-0000-0000-0000-000000000003",
  };
}
