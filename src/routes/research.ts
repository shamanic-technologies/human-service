// Fleet-wide research reads for the staff Research page (features-service serves
// the studies live from producer reads). Service-auth only, no identity headers.
import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { teaserScreeningResearch } from "../services/research-teaser-screenings.js";

const router = Router();

router.get("/internal/research/teaser-screenings", requireApiKey, async (_req, res) => {
  res.json(await teaserScreeningResearch());
});

export default router;
