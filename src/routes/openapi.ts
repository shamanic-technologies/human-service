import { Router } from "express";
import * as fs from "fs";
import { join } from "node:path";

const router = Router();

router.get("/openapi.json", (_req, res) => {
  const specPath = join(process.cwd(), "openapi.json");
  if (fs.existsSync(specPath)) {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    res.json(spec);
  } else {
    console.error("[human-service] openapi.json not found at", specPath);
    res.status(404).json({ error: "OpenAPI spec not generated" });
  }
});

export default router;
