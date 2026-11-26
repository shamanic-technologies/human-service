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
  ScreenBrandRelationRequestSchema,
} from "../schemas.js";
import {
  assignBrandRelation,
  BrandRelationError,
  ensureBrandRelations,
  listBrandRelations,
  revertBrandRelation,
  screenRelationLists,
} from "../services/brand-relations.js";
import { ChatConfigError, ChatServiceError } from "../lib/chat-client.js";
import { ProviderConfigError, ProviderError } from "../services/people-providers.js";
import { BRAND_RELATIONS } from "../lib/brand-relations.js";
import { BrandConfigError, BrandServiceError } from "../lib/brand-offers.js";
import { zodErrorBody } from "../lib/zod-error.js";

const router = Router();

router.get("/orgs/audiences/relations", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const parsed = BrandRelationsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(zodErrorBody(parsed.error));
    return;
  }
  const orgId = res.locals.orgId as string;
  res.json({ brandId: parsed.data.brandId, relations: await listBrandRelations(orgId, parsed.data.brandId) });
});

router.post("/orgs/audiences/relations/ensure", requireApiKey, requireOrgAndUser, async (req, res) => {
  const parsed = EnsureBrandRelationsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodErrorBody(parsed.error));
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
    res.status(400).json(zodErrorBody(parsed.error));
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
    res.status(400).json(zodErrorBody(parsed.error));
    return;
  }
  res.json(await revertBrandRelation(parsed.data.reason));
});

router.post("/internal/brand-relations/screen", requireApiKey, async (req, res) => {
  const parsed = ScreenBrandRelationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodErrorBody(parsed.error));
    return;
  }
  const input = { ...parsed.data, dryRun: req.query.dryRun === "true" };
  if (req.query.async === "true" && !input.dryRun) {
    void screenRelationLists(input).catch((err) => console.error(`[human-service] brand_relation.screen_failed brand=${input.brandId} relation=${input.relation}:`, err));
    res.status(202).json({ started: true });
    return;
  }
  try {
    res.json(await screenRelationLists(input));
  } catch (err) {
    if (err instanceof BrandRelationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof BrandServiceError || err instanceof BrandConfigError) {
      res.status(502).json({ error: err.message, source: "brand-service" });
      return;
    }
    if (err instanceof ChatServiceError || err instanceof ChatConfigError) {
      res.status(502).json({ error: err.message, source: "chat-service" });
      return;
    }
    if (err instanceof ProviderError || err instanceof ProviderConfigError) {
      res.status(502).json({ error: err.message, source: "apollo-service" });
      return;
    }
    throw err;
  }
});

export default router;
