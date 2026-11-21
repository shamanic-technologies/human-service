// OUTREACH-3WAYS-1121: a brand's populations that are not buyers of an offer
// (investors, industry peers). src/services/brand-relations.ts owns the model.
// Mounted BEFORE the audiences router so `/orgs/audiences/relations` never reads as `/:id`.
import { Router } from "express";
import { requireApiKey, requireOrgIdOnly, requireOrgAndUser, getWorkflowTracking } from "../middleware/auth.js";
import {
  AssignBrandRelationRequestSchema,
  BrandRelationsQuerySchema,
  EnsureBrandRelationsRequestSchema,
  RevertBrandRelationRequestSchema,
} from "../schemas.js";
import {
  assignBrandRelation,
  BrandRelationError,
  ensureBrandRelations,
  listBrandRelations,
  revertBrandRelation,
} from "../services/brand-relations.js";
import { BRAND_RELATIONS } from "../lib/brand-relations.js";
import { BrandConfigError, BrandServiceError } from "../lib/brand-offers.js";

const router = Router();

router.get("/orgs/audiences/relations", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const parsed = BrandRelationsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const orgId = res.locals.orgId as string;
  res.json({ brandId: parsed.data.brandId, relations: await listBrandRelations(orgId, parsed.data.brandId) });
});

router.post("/orgs/audiences/relations/ensure", requireApiKey, requireOrgAndUser, async (req, res) => {
  const parsed = EnsureBrandRelationsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const results = await ensureBrandRelations(
      { orgId: res.locals.orgId as string, brandId: parsed.data.brandId, relations: parsed.data.relations ?? BRAND_RELATIONS },
      {
        orgId: res.locals.orgId as string,
        userId: res.locals.userId as string,
        ...(res.locals.runId ? { runId: res.locals.runId as string } : {}),
        workflowTracking: getWorkflowTracking(res.locals),
      }
    );
    res.json({ results });
  } catch (err) {
    if (err instanceof BrandRelationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof BrandServiceError || err instanceof BrandConfigError) {
      res.status(502).json({ error: err.message, source: "brand-service" });
      return;
    }
    throw err;
  }
});

router.post("/internal/brand-relations/assign", requireApiKey, async (req, res) => {
  const parsed = AssignBrandRelationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(await assignBrandRelation({ ...parsed.data, dryRun: req.query.dryRun === "true" }));
  } catch (err) {
    if (err instanceof BrandRelationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post("/internal/brand-relations/revert", requireApiKey, async (req, res) => {
  const parsed = RevertBrandRelationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(await revertBrandRelation(parsed.data.reason));
});

export default router;
