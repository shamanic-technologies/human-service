import { Router } from "express";
import { requireApiKey, requireOrgIdOnly } from "../middleware/auth.js";
import {
  AudienceRefillQuerySchema,
  ListWideningProposalsQuerySchema,
  WideningProposalIdParamsSchema,
} from "../schemas.js";
import { runAudienceRefillSweep } from "../services/audience-refill.js";
import {
  acceptWideningProposal,
  declineWideningProposal,
  getWideningProposal,
  listWideningProposals,
  WideningProposalConflictError,
  WideningProposalNotFoundError,
} from "../services/audience-widening.js";
import { serializeAudiences } from "./audiences.js";

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

// --- Widening proposals (src/services/audience-widening.ts) ---
// Mounted BEFORE the audiences router, so `/orgs/audiences/widening-proposals`
// is never read as `/orgs/audiences/:id`.

function sendWideningError(res: import("express").Response, err: unknown): boolean {
  if (err instanceof WideningProposalNotFoundError) {
    res.status(404).json({ error: err.message });
    return true;
  }
  if (err instanceof WideningProposalConflictError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  return false;
}

router.get("/orgs/audiences/widening-proposals", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const parsed = ListWideningProposalsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const proposals = await listWideningProposals({ orgId: res.locals.orgId as string, ...parsed.data });
  res.json({ proposals });
});

router.get("/orgs/audiences/widening-proposals/:id", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const params = WideningProposalIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "Widening proposal not found." });
    return;
  }
  try {
    res.json({ proposal: await getWideningProposal(res.locals.orgId as string, params.data.id) });
  } catch (err) {
    if (!sendWideningError(res, err)) throw err;
  }
});

router.post("/orgs/audiences/widening-proposals/:id/accept", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const params = WideningProposalIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "Widening proposal not found." });
    return;
  }
  try {
    const result = await acceptWideningProposal({
      orgId: res.locals.orgId as string,
      id: params.data.id,
      decidedByUserId: (res.locals.userId as string | undefined) ?? null,
    });
    res.json({ proposal: result.proposal, audiences: await serializeAudiences(result.audiences) });
  } catch (err) {
    if (!sendWideningError(res, err)) throw err;
  }
});

router.post("/orgs/audiences/widening-proposals/:id/decline", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const params = WideningProposalIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "Widening proposal not found." });
    return;
  }
  try {
    const proposal = await declineWideningProposal({
      orgId: res.locals.orgId as string,
      id: params.data.id,
      decidedByUserId: (res.locals.userId as string | undefined) ?? null,
    });
    res.json({ proposal });
  } catch (err) {
    if (!sendWideningError(res, err)) throw err;
  }
});

export default router;
