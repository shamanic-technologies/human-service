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

// requireOrgAndUser: x-org-id AND x-user-id are required; x-run-id is optional.
// Used by the /orgs/people/* gateway, which proxies to apollo-service /
// apify-service — both require x-user-id for key resolution / attribution, so
// accepting a request without it would only produce a confusing 502 downstream.
// x-run-id stays optional (apollo dry-run/search don't need it; enrich uses it
// for cost tracking when present).
export function requireOrgAndUser(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const orgId = req.headers["x-org-id"] as string | undefined;
  const userId = req.headers["x-user-id"] as string | undefined;
  if (!orgId || !userId) {
    res.status(400).json({ error: "x-org-id and x-user-id headers are required" });
    return;
  }

  res.locals.orgId = orgId;
  res.locals.userId = userId;

  const runId = req.headers["x-run-id"] as string | undefined;
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
  // x-audience-id — the campaign's priority audience, stamped by workflow-service
  // on every campaign-run call. Carried through the tracking block so it
  // auto-forwards to every internal sibling (apollo/apify/chat/runs/keys/scraping)
  // for per-audience cost attribution. Absent outside the campaign flow → omitted,
  // never thrown (same optional treatment as x-run-id / x-workflow-slug).
  const audienceId = req.headers["x-audience-id"] as string | undefined;

  if (campaignId) res.locals.campaignId = campaignId;
  if (brandIds.length > 0) res.locals.brandIds = brandIds;
  if (workflowSlug) res.locals.workflowSlug = workflowSlug;
  if (audienceId) res.locals.audienceId = audienceId;
}

export interface WorkflowTrackingHeaders {
  campaignId?: string;
  brandIds?: string[];
  workflowSlug?: string;
  audienceId?: string;
}

export function getWorkflowTracking(locals: Record<string, unknown>): WorkflowTrackingHeaders {
  return {
    ...(locals.campaignId ? { campaignId: locals.campaignId as string } : {}),
    ...(locals.brandIds ? { brandIds: locals.brandIds as string[] } : {}),
    ...(locals.workflowSlug ? { workflowSlug: locals.workflowSlug as string } : {}),
    ...(locals.audienceId ? { audienceId: locals.audienceId as string } : {}),
  };
}

export function workflowTrackingToHeaders(tracking: WorkflowTrackingHeaders): Record<string, string> {
  return {
    ...(tracking.campaignId ? { "x-campaign-id": tracking.campaignId } : {}),
    ...(tracking.brandIds?.length ? { "x-brand-id": tracking.brandIds.join(",") } : {}),
    ...(tracking.workflowSlug ? { "x-workflow-slug": tracking.workflowSlug } : {}),
    ...(tracking.audienceId ? { "x-audience-id": tracking.audienceId } : {}),
  };
}
