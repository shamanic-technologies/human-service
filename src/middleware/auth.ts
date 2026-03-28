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

  // Optional workflow tracking headers — forwarded by workflow-service on all DAG calls
  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const brandId = req.headers["x-brand-id"] as string | undefined;
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;

  if (campaignId) res.locals.campaignId = campaignId;
  if (brandId) res.locals.brandId = brandId;
  if (workflowSlug) res.locals.workflowSlug = workflowSlug;

  next();
}

export interface WorkflowTrackingHeaders {
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
}

export function getWorkflowTracking(locals: Record<string, unknown>): WorkflowTrackingHeaders {
  return {
    ...(locals.campaignId ? { campaignId: locals.campaignId as string } : {}),
    ...(locals.brandId ? { brandId: locals.brandId as string } : {}),
    ...(locals.workflowSlug ? { workflowSlug: locals.workflowSlug as string } : {}),
  };
}

export function workflowTrackingToHeaders(tracking: WorkflowTrackingHeaders): Record<string, string> {
  return {
    ...(tracking.campaignId ? { "x-campaign-id": tracking.campaignId } : {}),
    ...(tracking.brandId ? { "x-brand-id": tracking.brandId } : {}),
    ...(tracking.workflowSlug ? { "x-workflow-slug": tracking.workflowSlug } : {}),
  };
}
