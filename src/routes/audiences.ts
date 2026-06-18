import { Router } from "express";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { audienceMembers, audiences, people } from "../db/schema.js";
import {
  requireApiKey,
  requireOrgIdOnly,
  requireOrgAndUser,
  getWorkflowTracking,
} from "../middleware/auth.js";
import {
  CreateAudienceRequestSchema,
  UpdateAudienceRequestSchema,
  ChangeAudienceStatusRequestSchema,
  ListAudiencesQuerySchema,
  AudienceMembersQuerySchema,
  AudienceStatsRequestSchema,
  SuggestAudiencesRequestSchema,
} from "../schemas.js";
import {
  computeStats,
  getAudienceInOrg,
  refreshCounts,
  suggestAudiences,
} from "../services/audiences.js";
import {
  ProviderError,
  ProviderConfigError,
  ProviderUnsupportedError,
  type Identity,
  type PeopleSearchFilters,
} from "../services/people-providers.js";
import { ChatServiceError, ChatConfigError } from "../lib/chat-client.js";

const router = Router();

const DEFAULT_LIMIT = 50;
const DEFAULT_MEMBERS_LIMIT = 100;

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

function sendProviderError(
  res: import("express").Response,
  err: unknown
): void {
  if (err instanceof ChatConfigError) {
    res.status(502).json({ error: err.message });
    return;
  }
  if (err instanceof ChatServiceError) {
    console.error(
      `[human-service] audiences.chat_error status=${err.status}`
    );
    res.status(502).json({ error: err.message, upstreamStatus: err.status });
    return;
  }
  if (err instanceof ProviderUnsupportedError) {
    res
      .status(501)
      .json({ error: err.message, provider: err.provider, capability: err.capability });
    return;
  }
  if (err instanceof ProviderConfigError) {
    res.status(502).json({ error: err.message, provider: err.provider });
    return;
  }
  if (err instanceof ProviderError) {
    console.error(
      `[human-service] audiences.provider_error provider=${err.provider} status=${err.status}`
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

// --- POST /orgs/audiences ---
router.post("/orgs/audiences", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const parsed = CreateAudienceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const orgId = res.locals.orgId as string;
  const userId = (res.locals.userId as string | undefined) ?? null;

  let audience;
  try {
    [audience] = await db
      .insert(audiences)
      .values({
        orgId,
        brandId: parsed.data.brandId,
        name: parsed.data.name,
        provider: parsed.data.provider ?? null,
        nlPrompt: parsed.data.nlPrompt ?? null,
        filters: parsed.data.filters ?? null,
        apolloCount: parsed.data.apolloCount ?? null,
        apifyCount: parsed.data.apifyCount ?? null,
        countedAt:
          parsed.data.apolloCount !== undefined ||
          parsed.data.apifyCount !== undefined
            ? new Date()
            : null,
        createdByUserId: userId,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      res
        .status(409)
        .json({ error: "An audience with this name already exists for this brand." });
      return;
    }
    throw err;
  }

  console.log(
    `[human-service] audience.create org=${orgId} audience=${audience.id} brand=${audience.brandId}`
  );

  res.status(201).json({ audience: serializeAudience(audience) });
});

// --- POST /orgs/audiences/suggest ---
// NL -> candidate audiences (apollo + apify), LLM-generated via chat-service,
// dry-run counted. Needs x-user-id (chat-service + providers key resolution).
router.post(
  "/orgs/audiences/suggest",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const parsed = SuggestAudiencesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const candidates = await suggestAudiences(
        parsed.data.nlPrompt,
        buildIdentity(res)
      );
      console.log(
        `[human-service] audience.suggest org=${res.locals.orgId} brand=${parsed.data.brandId} candidates=${candidates.length}`
      );
      res.json({ candidates });
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

// --- GET /orgs/audiences ---
router.get("/orgs/audiences", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const parsedQuery = ListAudiencesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }

  const orgId = res.locals.orgId as string;
  const limit = parsedQuery.data.limit ?? DEFAULT_LIMIT;
  const offset = parsedQuery.data.offset ?? 0;
  const brandFilter = parsedQuery.data.brandId;
  const statusFilter = parsedQuery.data.status;

  const conditions = [eq(audiences.orgId, orgId)];
  if (brandFilter) conditions.push(eq(audiences.brandId, brandFilter));
  if (statusFilter) conditions.push(eq(audiences.status, statusFilter));
  const whereClause = and(...conditions);

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(audiences)
      .where(whereClause)
      .orderBy(desc(audiences.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(audiences).where(whereClause),
  ]);

  res.json({
    audiences: rows.map(serializeAudience),
    total: totalRows[0]?.value ?? 0,
    limit,
    offset,
  });
});

// --- POST /orgs/audiences/stats (declared before /:id to avoid param capture) ---
router.post(
  "/orgs/audiences/stats",
  requireApiKey,
  requireOrgIdOnly,
  async (req, res) => {
    const parsed = AudienceStatsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const orgId = res.locals.orgId as string;
    const stats = await computeStats(orgId, {
      emails: parsed.data.emails,
      personIds: parsed.data.personIds,
    });
    res.json(stats);
  }
);

// --- GET /orgs/audiences/:id ---
router.get("/orgs/audiences/:id", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const orgId = res.locals.orgId as string;
  const audience = await getAudienceInOrg(orgId, req.params.id);
  if (!audience) {
    res.status(404).json({ error: "Audience not found" });
    return;
  }
  res.json({ audience: serializeAudience(audience) });
});

// --- PATCH /orgs/audiences/:id ---
router.patch("/orgs/audiences/:id", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const parsed = UpdateAudienceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // An audience is immutable except status. PATCH edits only metadata
  // (name / nlPrompt); brandId and filters are rejected by the .strict() schema
  // above (editing filters = a new audience). Status changes go through
  // PATCH /orgs/audiences/:id/status.
  const orgId = res.locals.orgId as string;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.nlPrompt !== undefined) updates.nlPrompt = parsed.data.nlPrompt;

  let updated;
  try {
    [updated] = await db
      .update(audiences)
      .set(updates)
      .where(and(eq(audiences.id, req.params.id), eq(audiences.orgId, orgId)))
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      res
        .status(409)
        .json({ error: "An audience with this name already exists for this brand." });
      return;
    }
    throw err;
  }

  if (!updated) {
    res.status(404).json({ error: "Audience not found" });
    return;
  }

  res.json({ audience: serializeAudience(updated) });
});

// --- PATCH /orgs/audiences/:id/status (mutates ONLY status) ---
// Mirrors brand-service persona status flips. archive is a soft state — the
// hard DELETE route below stays for true cleanup.
router.patch(
  "/orgs/audiences/:id/status",
  requireApiKey,
  requireOrgIdOnly,
  async (req, res) => {
    const parsed = ChangeAudienceStatusRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const orgId = res.locals.orgId as string;
    const [updated] = await db
      .update(audiences)
      .set({ status: parsed.data.status, updatedAt: new Date() })
      .where(and(eq(audiences.id, req.params.id), eq(audiences.orgId, orgId)))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Audience not found" });
      return;
    }

    console.log(
      `[human-service] audience.status org=${orgId} audience=${updated.id} status=${updated.status}`
    );
    res.json({ audience: serializeAudience(updated) });
  }
);

// --- DELETE /orgs/audiences/:id ---
router.delete("/orgs/audiences/:id", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const orgId = res.locals.orgId as string;
  const deleted = await db
    .delete(audiences)
    .where(and(eq(audiences.id, req.params.id), eq(audiences.orgId, orgId)))
    .returning({ id: audiences.id });

  if (deleted.length === 0) {
    res.status(404).json({ error: "Audience not found" });
    return;
  }

  console.log(`[human-service] audience.delete org=${orgId} audience=${req.params.id}`);
  res.status(204).send();
});

// --- POST /orgs/audiences/:id/refresh-count ---
// Re-snapshot per-provider counts via the free dry-run. Needs x-user-id (apollo/
// apify key resolution), so it uses requireOrgAndUser unlike the CRUD routes.
router.post(
  "/orgs/audiences/:id/refresh-count",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const orgId = res.locals.orgId as string;
    const audience = await getAudienceInOrg(orgId, req.params.id);
    if (!audience) {
      res.status(404).json({ error: "Audience not found" });
      return;
    }

    try {
      const counts = await refreshCounts(
        (audience.filters ?? {}) as PeopleSearchFilters,
        buildIdentity(res)
      );
      const [updated] = await db
        .update(audiences)
        .set({
          apolloCount: counts.apolloCount,
          apifyCount: counts.apifyCount,
          countedAt: counts.countedAt,
          updatedAt: new Date(),
        })
        .where(and(eq(audiences.id, req.params.id), eq(audiences.orgId, orgId)))
        .returning();
      res.json({ audience: serializeAudience(updated) });
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

// --- GET /orgs/audiences/:id/members ---
router.get(
  "/orgs/audiences/:id/members",
  requireApiKey,
  requireOrgIdOnly,
  async (req, res) => {
    const parsedQuery = AudienceMembersQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.message });
      return;
    }

    const orgId = res.locals.orgId as string;
    const audience = await getAudienceInOrg(orgId, req.params.id);
    if (!audience) {
      res.status(404).json({ error: "Audience not found" });
      return;
    }

    const limit = parsedQuery.data.limit ?? DEFAULT_MEMBERS_LIMIT;
    const offset = parsedQuery.data.offset ?? 0;
    const whereClause = and(
      eq(audienceMembers.audienceId, req.params.id),
      eq(audienceMembers.orgId, orgId)
    );

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          personId: people.id,
          emailNorm: people.emailNorm,
          linkedinUrlNorm: people.linkedinUrlNorm,
          firstName: people.firstName,
          lastName: people.lastName,
          fullName: people.fullName,
          companyDomain: people.companyDomain,
          source: audienceMembers.source,
          confidence: audienceMembers.confidence,
          joinedAt: audienceMembers.joinedAt,
          lastServedAt: audienceMembers.lastServedAt,
        })
        .from(audienceMembers)
        .innerJoin(people, eq(audienceMembers.personId, people.id))
        .where(whereClause)
        .orderBy(asc(audienceMembers.joinedAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(audienceMembers).where(whereClause),
    ]);

    res.json({
      members: rows.map((r) => ({
        personId: r.personId,
        emailNorm: r.emailNorm,
        linkedinUrlNorm: r.linkedinUrlNorm,
        firstName: r.firstName,
        lastName: r.lastName,
        fullName: r.fullName,
        companyDomain: r.companyDomain,
        source: r.source,
        confidence: r.confidence,
        joinedAt: r.joinedAt.toISOString(),
        lastServedAt: r.lastServedAt.toISOString(),
      })),
      total: totalRows[0]?.value ?? 0,
      limit,
      offset,
    });
  }
);

// --- helpers ---

// Postgres unique_violation (e.g. the name-unique-per-brand index). postgres.js
// surfaces it as an error with `.code === "23505"`.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

function serializeAudience(row: typeof audiences.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    brandId: row.brandId,
    name: row.name,
    nlPrompt: row.nlPrompt,
    provider: row.provider,
    status: row.status,
    source: row.source,
    filters: row.filters,
    apolloCount: row.apolloCount,
    apifyCount: row.apifyCount,
    countedAt: row.countedAt ? row.countedAt.toISOString() : null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default router;
