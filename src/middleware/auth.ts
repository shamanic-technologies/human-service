import { Request, Response, NextFunction } from "express";

export function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const apiKey = req.headers["x-api-key"] as string;
  if (!apiKey || apiKey !== process.env.HUMAN_SERVICE_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function requireIdentity(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const orgId = req.headers["x-org-id"] as string | undefined;
  const userId = req.headers["x-user-id"] as string | undefined;
  const runId = req.headers["x-run-id"] as string | undefined;

  if (!orgId || !userId || !runId) {
    res.status(400).json({ error: "x-org-id, x-user-id, and x-run-id headers are required" });
    return;
  }

  res.locals.orgId = orgId;
  res.locals.userId = userId;
  res.locals.runId = runId;

  parseOptionalTrackingHeaders(req, res);
  next();
}

// requireOrgIdOnly: x-org-id is the only required header. x-user-id and x-run-id
// are parsed if present (used for `created_by_user_id`, `added_by_user_id`,
// and run-tracking parent linkage). Used by /orgs/lists/* CRM endpoints which
// can be called from a UI session without a parent workflow run.
export function requireOrgIdOnly(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId) {
    res.status(400).json({ error: "x-org-id header is required" });
    return;
  }

  res.locals.orgId = orgId;

  const userId = req.headers["x-user-id"] as string | undefined;
  const runId = req.headers["x-run-id"] as string | undefined;
  if (userId) res.locals.userId = userId;
  if (runId) res.locals.runId = runId;

  parseOptionalTrackingHeaders(req, res);
  next();
}

function parseOptionalTrackingHeaders(req: Request, res: Response): void {
  // Optional workflow tracking headers — forwarded by workflow-service on all DAG calls
  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const rawBrandId = req.headers["x-brand-id"] as string | undefined;
  const brandIds = rawBrandId
    ? String(rawBrandId).split(",").map(s => s.trim()).filter(Boolean)
    : [];
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;

  if (campaignId) res.locals.campaignId = campaignId;
  if (brandIds.length > 0) res.locals.brandIds = brandIds;
  if (workflowSlug) res.locals.workflowSlug = workflowSlug;
}

export interface WorkflowTrackingHeaders {
  campaignId?: string;
  brandIds?: string[];
  workflowSlug?: string;
}

export function getWorkflowTracking(locals: Record<string, unknown>): WorkflowTrackingHeaders {
  return {
    ...(locals.campaignId ? { campaignId: locals.campaignId as string } : {}),
    ...(locals.brandIds ? { brandIds: locals.brandIds as string[] } : {}),
    ...(locals.workflowSlug ? { workflowSlug: locals.workflowSlug as string } : {}),
  };
}

export function workflowTrackingToHeaders(tracking: WorkflowTrackingHeaders): Record<string, string> {
  return {
    ...(tracking.campaignId ? { "x-campaign-id": tracking.campaignId } : {}),
    ...(tracking.brandIds?.length ? { "x-brand-id": tracking.brandIds.join(",") } : {}),
    ...(tracking.workflowSlug ? { "x-workflow-slug": tracking.workflowSlug } : {}),
  };
}
