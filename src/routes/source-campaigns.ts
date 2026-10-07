import { Router } from "express";
import { requireApiKey, requireOrgIdOnly } from "../middleware/auth.js";
import { SourceCampaignReconcileQuerySchema, SourceCampaignStateRequestSchema } from "../schemas.js";
import {
  applySourceCampaignState,
  runSourceCampaignReconcile,
  UnknownSourceOriginError,
} from "../services/source-campaigns.js";
import { SourcingOriginError } from "../services/sourcing-origin.js";

const router = Router();

// POST /orgs/source-campaigns/state — a source campaign of an offer was turned ON / OFF
// (src/services/source-campaigns.ts). Always applied (the explicit "it changed").
router.post("/orgs/source-campaigns/state", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const parsed = SourceCampaignStateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await applySourceCampaignState({
      orgId: res.locals.orgId as string,
      userId: (res.locals.userId as string | undefined) ?? null,
      ...parsed.data,
      mode: "transition",
    });
    res.json(result);
  } catch (err) {
    if (err instanceof UnknownSourceOriginError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof SourcingOriginError) {
      // The catalogue that says which list an origin is could not be read.
      res.status(502).json({ error: err.message });
      return;
    }
    console.error("[human-service] source_campaign.state_error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /internal/source-campaigns/reconcile?dryRun&orgId&offerId — reconcile now.
router.post("/internal/source-campaigns/reconcile", requireApiKey, async (req, res) => {
  const parsed = SourceCampaignReconcileQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await runSourceCampaignReconcile({
      dryRun: parsed.data.dryRun === "true",
      orgId: parsed.data.orgId,
      offerId: parsed.data.offerId,
    });
    if (!result) {
      res.status(409).json({ error: "A reconcile is already running, or migrations are not ready." });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error("[human-service] source_campaign.reconcile_error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
