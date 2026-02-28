import express from "express";
import cors from "cors";
import healthRoutes from "../../src/routes/health.js";
import openapiRoutes from "../../src/routes/openapi.js";
import humanRoutes from "../../src/routes/humans.js";
import methodologyRoutes from "../../src/routes/methodology.js";

export function createTestApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use(healthRoutes);
  app.use(openapiRoutes);
  app.use(humanRoutes);
  app.use(methodologyRoutes);

  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

export function getAuthHeaders() {
  return {
    "X-API-Key": "test-api-key",
    "Content-Type": "application/json",
  };
}
