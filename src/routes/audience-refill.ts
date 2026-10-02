import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { AudienceRefillQuerySchema } from "../schemas.js";
import { runAudienceRefillSweep } from "../services/audience-refill.js";

const router = Router();

// POST /internal/audience-refill?dryRun=true|false&brandId=<uuid>
//
// Run the audience refill now instead of waiting for its next tick (see
// src/services/audience-refill.ts). dryRun measures every recently-served
// brand's pool, reads billing and reports who WOULD be refilled, spending and
// writing nothing. brandId narrows to one brand. Never starts a campaign.
router.post("/internal/audience-refill", requireApiKey, async (req, res) => {
  const parsed = AudienceRefillQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await runAudienceRefillSweep({
    dryRun: parsed.data.dryRun === "true",
    brandId: parsed.data.brandId,
  });
  if (!result) {
    res.status(409).json({ error: "A refill is already running, or migrations are not ready." });
    return;
  }
  res.json(result);
});

export default router;
