// AUDIENCE-PER-OFFER-1107: realign a brand on ONE audience per offer
// (src/services/offer-audiences.ts). Staff / service only.
import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { RealignOfferAudiencesRequestSchema, RevertOfferAudiencesRequestSchema } from "../schemas.js";
import { RealignError, realignOfferAudiences, revertOfferAudienceRealignment } from "../services/offer-audiences.js";
import { zodErrorBody } from "../lib/zod-error.js";
import { alignOfferAudiences } from "../services/offer-audience-align-sweep.js";

const router = Router();

router.post("/internal/offer-audiences/realign", requireApiKey, async (req, res) => {
  const parsed = RealignOfferAudiencesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodErrorBody(parsed.error));
    return;
  }
  try {
    res.json(await realignOfferAudiences({ ...parsed.data, dryRun: req.query.dryRun === "true" }));
  } catch (err) {
    if (err instanceof RealignError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// ONBOARDING-ONE-AUDIENCE-1126: align every offer still holding live role-NULL rows now (also every 5 min).
router.post("/internal/offer-audiences/align", requireApiKey, async (req, res) => {
  const brandId = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
  if (brandId && !/^[0-9a-f-]{36}$/i.test(brandId)) {
    res.status(400).json({ error: "brandId: Invalid UUID" });
    return;
  }
  res.json(await alignOfferAudiences({ dryRun: req.query.dryRun === "true", brandId }));
});

router.post("/internal/offer-audiences/realign/revert", requireApiKey, async (req, res) => {
  const parsed = RevertOfferAudiencesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodErrorBody(parsed.error));
    return;
  }
  res.json(await revertOfferAudienceRealignment(parsed.data.reason));
});

export default router;
