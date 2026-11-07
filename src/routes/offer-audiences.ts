// AUDIENCE-PER-OFFER-1107: realign a brand on ONE audience per offer
// (src/services/offer-audiences.ts). Staff / service only.
import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { RealignOfferAudiencesRequestSchema, RevertOfferAudiencesRequestSchema } from "../schemas.js";
import { RealignError, realignOfferAudiences, revertOfferAudienceRealignment } from "../services/offer-audiences.js";

const router = Router();

router.post("/internal/offer-audiences/realign", requireApiKey, async (req, res) => {
  const parsed = RealignOfferAudiencesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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

router.post("/internal/offer-audiences/realign/revert", requireApiKey, async (req, res) => {
  const parsed = RevertOfferAudiencesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(await revertOfferAudienceRealignment(parsed.data.reason));
});

export default router;
