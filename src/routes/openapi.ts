import { Router } from "express";
import * as fs from "fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

router.get("/openapi.json", (_req, res) => {
  const specPath = join(__dirname, "../../openapi.json");
  if (fs.existsSync(specPath)) {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    res.json(spec);
  } else {
    res.status(404).json({ error: "OpenAPI spec not generated" });
  }
});

export default router;
