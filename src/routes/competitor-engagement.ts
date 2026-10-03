import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { CompetitorEngagementSweepQuerySchema } from "../schemas.js";
import { runCompetitorEngagementSweep } from "../services/competitor-engagement-audience.js";

const router = Router();

// POST /internal/competitor-engagement-audiences?dryRun=true|false&brandId=<uuid>
//
// Run the competitor-engagement sweep now instead of waiting for its tick (see
// src/services/competitor-engagement-audience.ts): every brand with an active
// audience and none of this kind on its main offer, whose billing can charge
// it, gets one (free to create). dryRun reads billing and reports, creating
// and spending nothing. brandId narrows to one brand.
router.post("/internal/competitor-engagement-audiences", requireApiKey, async (req, res) => {
  const parsed = CompetitorEngagementSweepQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await runCompetitorEngagementSweep({
    dryRun: parsed.data.dryRun === "true",
    brandId: parsed.data.brandId,
  });
  if (!result) {
    res.status(409).json({ error: "A sweep is already running, or migrations are not ready." });
    return;
  }
  res.json(result);
});

export default router;
