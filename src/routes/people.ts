import { Router } from "express";
import { requireApiKey, requireOrgAndUser, getWorkflowTracking } from "../middleware/auth.js";
import {
  PeopleSearchRequestSchema,
  ResolveEmailRequestSchema,
  DryRunRequestSchema,
  FiltersPromptQuerySchema,
} from "../schemas.js";
import {
  peopleSearch,
  resolveEmail,
  dryRun,
  filtersPrompt,
  ProviderError,
  ProviderConfigError,
  ProviderUnsupportedError,
  type Identity,
} from "../services/people-providers.js";

const router = Router();

// Build the identity/tracking context forwarded to apollo/apify-service.
function buildIdentity(res: import("express").Response): Identity {
  return {
    orgId: res.locals.orgId as string,
    ...(res.locals.userId ? { userId: res.locals.userId as string } : {}),
    ...(res.locals.runId ? { runId: res.locals.runId as string } : {}),
    ...(res.locals.campaignId
      ? { campaignId: res.locals.campaignId as string }
      : {}),
    ...(res.locals.brandIds
      ? { brandIds: res.locals.brandIds as string[] }
      : {}),
    workflowTracking: getWorkflowTracking(res.locals),
  };
}

// Map a thrown provider error to the right HTTP status. Fail loud — a provider
// outage surfaces as 502, an unsupported capability as 501; never swallowed.
function sendProviderError(
  res: import("express").Response,
  err: unknown
): void {
  if (err instanceof ProviderUnsupportedError) {
    res.status(501).json({
      error: err.message,
      provider: err.provider,
      capability: err.capability,
    });
    return;
  }
  if (err instanceof ProviderConfigError) {
    res.status(502).json({ error: err.message, provider: err.provider });
    return;
  }
  if (err instanceof ProviderError) {
    console.error(
      `[human-service] people.provider_error provider=${err.provider} status=${err.status}`
    );
    res.status(502).json({
      error: err.message,
      provider: err.provider,
      upstreamStatus: err.status,
    });
    return;
  }
  throw err;
}

// --- POST /orgs/people/search ---
router.post(
  "/orgs/people/search",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const parsed = PeopleSearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const result = await peopleSearch({
        provider: parsed.data.provider,
        need: parsed.data.need,
        filters: parsed.data.filters ?? {},
        isNextPage: parsed.data.nextPage,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        identity: buildIdentity(res),
      });
      console.log(
        `[human-service] people.search org=${res.locals.orgId} provider=${result.provider} returned=${result.people.length} total=${result.total} done=${result.done}`
      );
      res.json(result);
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

// --- POST /orgs/people/resolve-email ---
router.post(
  "/orgs/people/resolve-email",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const parsed = ResolveEmailRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const result = await resolveEmail({
        provider: parsed.data.provider,
        providerPersonId: parsed.data.providerPersonId,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        domain: parsed.data.domain,
        includeInferred: parsed.data.includeInferred,
        identity: buildIdentity(res),
      });
      console.log(
        `[human-service] people.resolve_email org=${res.locals.orgId} provider=${result.provider} found=${result.person !== null}`
      );
      res.json(result);
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

// --- POST /orgs/people/search/dry-run ---
router.post(
  "/orgs/people/search/dry-run",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const parsed = DryRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const result = await dryRun({
        provider: parsed.data.provider,
        filters: parsed.data.filters ?? {},
        identity: buildIdentity(res),
      });
      res.json(result);
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

// --- GET /orgs/people/filters-prompt ---
router.get(
  "/orgs/people/filters-prompt",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const parsed = FiltersPromptQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const result = await filtersPrompt({
        provider: parsed.data.provider,
        identity: buildIdentity(res),
      });
      res.json(result);
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

export default router;
