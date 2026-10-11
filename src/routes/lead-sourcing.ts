import { Router } from "express";
import { requireApiKey, requireOrgIdOnly } from "../middleware/auth.js";
import { LeadSourcingSourcesQuerySchema } from "../schemas.js";
import { fetchOfferSourceCampaigns } from "../lib/campaign-source-campaigns.js";
import {
  ensureLeadSourcingChoice,
  LEAD_SOURCING_SLUG,
  readLeadSourcingChoice,
  refreshLeadSourcingChoice,
  type OriginDecision,
} from "../services/lead-sourcing.js";

const router = Router();

// GET /orgs/lead-sourcing/sources?brandId&offerId — which origins Lead Sourcing uses for the brand
// (src/services/lead-sourcing.ts). Read by lead-service before filing a serve under Lead Sourcing, and by a
// workflow on the Lead Sourcing pipe. Created on first read while Lead Sourcing is ON; re-decided on the
// measured ROI (at most hourly) when the caller states its user and run.
router.get("/orgs/lead-sourcing/sources", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const parsed = LeadSourcingSourcesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const scope = { orgId: res.locals.orgId as string, brandId: parsed.data.brandId, offerId: parsed.data.offerId };
  try {
    const sources = await fetchOfferSourceCampaigns(scope);
    const ls = sources.find((s) => s.featureSlug === LEAD_SOURCING_SLUG) ?? null;
    const on = !!ls?.running && !!ls.campaignId;
    let choice = on ? await ensureLeadSourcingChoice(scope, ls!.campaignId) : await readLeadSourcingChoice(scope);
    const userId = res.locals.userId as string | undefined;
    const runId = res.locals.runId as string | undefined;
    if (choice && on && userId && runId) choice = await refreshLeadSourcingChoice(scope, { userId, runId });
    const reasons = (choice?.reasons ?? {}) as Record<string, OriginDecision>;
    res.json({
      brandId: scope.brandId,
      offerId: scope.offerId,
      leadSourcingOn: on,
      decided: !!choice,
      basis: choice?.basis ?? null,
      chosenOriginSlugs: [...(choice?.chosenOriginSlugs ?? [])].sort(),
      universeOriginSlugs: [...(choice?.universeOriginSlugs ?? [])].sort(),
      sources: (choice?.universeOriginSlugs ?? []).map((originSlug) => ({
        originSlug,
        chosen: (choice?.chosenOriginSlugs ?? []).includes(originSlug),
        reason: reasons[originSlug]?.reason ?? "no_evidence_read",
        evidence: reasons[originSlug]?.evidence ?? null,
        bestCostPerPositiveReplyUsd: reasons[originSlug]?.bestCostPerPositiveReplyUsd ?? null,
      })),
      decidedAt: choice?.decidedAt.toISOString() ?? null,
      evidenceAt: choice?.evidenceAt?.toISOString() ?? null,
    });
  } catch (err) {
    console.error("[human-service] lead_sourcing.read_error", err);
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
