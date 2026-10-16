// Internal (service-auth) one-time merge of per-source audience rows into their
// profile's sources, and its revert (AUDIENCE-SOURCES-1016). Engine + rationale in
// src/services/source-audience-merge.ts. `?dryRun=true` writes nothing;
// `?orgId=` / `?brandId=` narrow.
import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { MergeSourceAudiencesQuerySchema as QuerySchema } from "../schemas.js";
import { mergeSourceAudiences, revertSourceAudienceMerge } from "../services/source-audience-merge.js";

const router = Router();

router.post("/internal/merge-source-audiences", requireApiKey, async (req, res) => {
  const q = QuerySchema.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  res.json(await mergeSourceAudiences({ dryRun: q.data.dryRun === "true", orgId: q.data.orgId, brandId: q.data.brandId }));
});

router.post("/internal/merge-source-audiences/revert", requireApiKey, async (req, res) => {
  const q = QuerySchema.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  res.json(await revertSourceAudienceMerge({ dryRun: q.data.dryRun === "true", orgId: q.data.orgId, brandId: q.data.brandId }));
});

export default router;
