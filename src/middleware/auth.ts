import { Request, Response, NextFunction } from "express";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identity ids (org/user/run) are single values. A DOUBLED HTTP header arrives
 * comma-joined by Node (e.g. an upstream that sets `x-org-id` twice yields
 * "<uuid>," or "<uuid>,<uuid>"). Collapse to the distinct, non-empty set and
 * accept ONLY when exactly one value remains — so a doubled-but-identical header
 * is tolerated (dedup, HTTP-correct) while a genuinely ambiguous "<uuidA>,<uuidB>"
 * is rejected. Returns null on empty / ambiguous, letting the caller 400.
 */
function normalizeIdHeader(raw: string | undefined): string | null {
  if (!raw) return null;
  const distinct = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  return distinct.length === 1 ? distinct[0] : null;
}

/**
 * As `normalizeIdHeader`, but also enforces UUID shape. `x-org-id` is a `uuid`
 * column downstream, so a malformed value (comma-joined header, stray text) that
 * reaches a query throws Postgres 22P02 — and an UNHANDLED rejection there crashed
 * the whole process (crash-loop). Validate at the door → 400, never let it hit SQL.
 * Mirrors runs-service, which already 400s a non-UUID x-org-id.
 */
function normalizeUuidHeader(raw: string | undefined): string | null {
  const value = normalizeIdHeader(raw);
  return value && UUID_RE.test(value) ? value : null;
}

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
  const orgId = normalizeUuidHeader(req.headers["x-org-id"] as string | undefined);
  const userId = normalizeIdHeader(req.headers["x-user-id"] as string | undefined);
  const runId = normalizeIdHeader(req.headers["x-run-id"] as string | undefined);

  if (!orgId || !userId || !runId) {
    res.status(400).json({ error: "x-org-id (valid UUID), x-user-id, and x-run-id headers are required" });
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
  const orgId = normalizeUuidHeader(req.headers["x-org-id"] as string | undefined);
  if (!orgId) {
    res.status(400).json({ error: "x-org-id header is required and must be a valid UUID" });
    return;
  }

  res.locals.orgId = orgId;

  const userId = normalizeIdHeader(req.headers["x-user-id"] as string | undefined);
  const runId = normalizeIdHeader(req.headers["x-run-id"] as string | undefined);
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
  const orgId = normalizeUuidHeader(req.headers["x-org-id"] as string | undefined);
  const userId = normalizeIdHeader(req.headers["x-user-id"] as string | undefined);
  if (!orgId || !userId) {
    res.status(400).json({ error: "x-org-id (valid UUID) and x-user-id headers are required" });
    return;
  }

  res.locals.orgId = orgId;
  res.locals.userId = userId;

  const runId = normalizeIdHeader(req.headers["x-run-id"] as string | undefined);
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
  // x-feature-slug — the feature catalogue slug the campaign belongs to
  // (features-service, e.g. "sales-cold-email-outreach" / "sales-crm-email-outreach").
  // lead-service forwards it on every serve-next call. Carried through the tracking
  // block so it (a) auto-forwards to internal siblings for tracing/attribution and
  // (b) lets serve-next route by FEATURE IDENTITY (the CRM-outreach feature sources
  // from crm-service regardless of the audience's stored provider). Absent outside
  // the campaign flow → omitted, never thrown (same optional treatment as x-run-id).
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;

  if (campaignId) res.locals.campaignId = campaignId;
  if (brandIds.length > 0) res.locals.brandIds = brandIds;
  if (workflowSlug) res.locals.workflowSlug = workflowSlug;
  if (audienceId) res.locals.audienceId = audienceId;
  if (featureSlug) res.locals.featureSlug = featureSlug;
}

export interface WorkflowTrackingHeaders {
  campaignId?: string;
  brandIds?: string[];
  workflowSlug?: string;
  audienceId?: string;
  featureSlug?: string;
}

export function getWorkflowTracking(locals: Record<string, unknown>): WorkflowTrackingHeaders {
  return {
    ...(locals.campaignId ? { campaignId: locals.campaignId as string } : {}),
    ...(locals.brandIds ? { brandIds: locals.brandIds as string[] } : {}),
    ...(locals.workflowSlug ? { workflowSlug: locals.workflowSlug as string } : {}),
    ...(locals.audienceId ? { audienceId: locals.audienceId as string } : {}),
    ...(locals.featureSlug ? { featureSlug: locals.featureSlug as string } : {}),
  };
}

export function workflowTrackingToHeaders(tracking: WorkflowTrackingHeaders): Record<string, string> {
  return {
    ...(tracking.campaignId ? { "x-campaign-id": tracking.campaignId } : {}),
    ...(tracking.brandIds?.length ? { "x-brand-id": tracking.brandIds.join(",") } : {}),
    ...(tracking.workflowSlug ? { "x-workflow-slug": tracking.workflowSlug } : {}),
    ...(tracking.audienceId ? { "x-audience-id": tracking.audienceId } : {}),
    ...(tracking.featureSlug ? { "x-feature-slug": tracking.featureSlug } : {}),
  };
}
