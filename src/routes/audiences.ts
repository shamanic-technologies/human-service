import { Router } from "express";
import { EmailVerificationError } from "../lib/email-verification.js";
import { and, asc, count, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import {
  audienceTargetFields,
  ensureTargetText,
  targetTextMissingReason,
} from "../services/audience-target-text.js";
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
  GenerateAudienceAvatarRequestSchema,
  SplitAudiencesRequestSchema,
  ConfirmAudienceSplitRequestSchema,
  PreviewCompaniesQuerySchema,
  LaunchAudiencePortfolioRequestSchema,
  CreateLinkedinEngagementAudienceRequestSchema,
} from "../schemas.js";
import { createLinkedinEngagementAudience } from "../services/linkedin-engagement-audience.js";
import { isLinkedinEngagementFilters } from "../lib/apollo-audiences.js";
import { launchAudiencePortfolio } from "../services/audience-portfolio.js";
import {
  proposeAudienceSplit,
  confirmAudienceSplit,
  SplitNameConflictError,
} from "../services/audience-split.js";
import {
  AudienceTargetOfferNotFoundError,
  draftAudienceTarget,
} from "../services/audience-target.js";
import { BrandConfigError, BrandServiceError } from "../lib/brand-offers.js";
import {
  computeStats,
  computeAudienceContactability,
  type AudienceContactabilityEntry,
  getAudienceInOrg,
  refreshAudienceCounts,
  refreshAudienceCountIfStale,
  suggestAudiences,
  serveNextPerson,
  ensureApolloPointer,
  needsApolloPointerBuild,
  generateAvatar,
  buildAvatarPrompt,
  AudienceNotServableError,
} from "../services/audiences.js";
import {
  ProviderError,
  ProviderConfigError,
  ProviderUnsupportedError,
  type Identity,
} from "../services/people-providers.js";
import { ChatServiceError, ChatConfigError } from "../lib/chat-client.js";
import {
  OptOutConfigError,
  OptOutSourceError,
} from "../lib/instantly-optouts.js";
import {
  WonLeadsConfigError,
  WonLeadsSourceError,
} from "../lib/lead-won.js";
import {
  BounceConfigError,
  BounceSourceError,
} from "../lib/instantly-bounces.js";

import { crmListUploads } from "../lib/crm-contacts.js";
import { getAudiencePreview } from "../services/audience-preview.js";
import {
  checkNextPreviewPerson,
  getPreviewEmailChecks,
} from "../services/audience-preview-email-checks.js";
import {
  checkCompanyRowEmail,
  getAudiencePreviewCompanies,
  getCompanyRowEmailChecks,
  PREVIEW_COMPANIES_DEFAULT_LIMIT,
  PreviewCompanyRowError,
} from "../services/audience-preview-companies.js";

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
  if (err instanceof BrandConfigError || err instanceof BrandServiceError) {
    // What the client sells could not be read, so no audience target can be
    // written from it. Never stored without one.
    console.error(
      `[human-service] audiences.brand_source_error ${err.name}: ${err.message}`
    );
    res.status(502).json({ error: err.message, source: "brand-service" });
    return;
  }
  if (err instanceof AudienceTargetOfferNotFoundError) {
    res.status(502).json({ error: err.message, source: "brand-service" });
    return;
  }
  if (err instanceof ProviderUnsupportedError) {
    res
      .status(501)
      .json({ error: err.message, provider: err.provider, capability: err.capability });
    return;
  }
  if (err instanceof OptOutConfigError || err instanceof OptOutSourceError) {
    // The serve path could not read the org's consent log. A gate that cannot
    // read its own input must not wave people through, so this fails the request
    // rather than serving somebody who may have asked us to stop.
    console.error(
      `[human-service] audiences.opt_out_source_error ${err.name}: ${err.message}`
    );
    res.status(502).json({ error: err.message, source: "instantly-service" });
    return;
  }
  if (err instanceof BounceConfigError || err instanceof BounceSourceError) {
    // The serve path could not read the fleet's bounce record. Same posture as
    // the consent log: never serve through a gate that cannot read its own
    // input — an empty answer would hand back an address we know is dead.
    console.error(
      `[human-service] audiences.bounce_source_error ${err.name}: ${err.message}`
    );
    res.status(502).json({ error: err.message, source: "instantly-service" });
    return;
  }
  if (err instanceof WonLeadsConfigError || err instanceof WonLeadsSourceError) {
    // The serve path could not read the brand's won people. Same posture as the
    // consent log: never serve through a gate that cannot read its own input —
    // an empty answer would hand a paying client back to cold outreach.
    console.error(
      `[human-service] audiences.won_leads_source_error ${err.name}: ${err.message}`
    );
    res.status(502).json({ error: err.message, source: "lead-service" });
    return;
  }
  if (err instanceof EmailVerificationError) {
    // The revealed address could not be verified. Never serve it unverified —
    // that spends the send and the sender reputation the check protects.
    console.error(`[human-service] audiences.verify_email_error ${err.message}`);
    res.status(502).json({ error: err.message, source: "email-verification" });
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

  // Source binding — the audience represents ONE of the brand's imported CRM
  // files. Validate the pointer against crm-service BEFORE persisting: a binding
  // to an upload that is not this brand's would silently serve nobody forever
  // (and must never be able to reach another brand's people). Fail loud — a
  // crm-service outage surfaces as 502, never a dead pointer written anyway.
  if (parsed.data.crmUploadId) {
    let uploads;
    try {
      uploads = await crmListUploads(parsed.data.brandId, buildIdentity(res));
    } catch (err) {
      sendProviderError(res, err);
      return;
    }
    if (!uploads.some((u) => u.id === parsed.data.crmUploadId)) {
      res.status(400).json({
        error:
          "crmUploadId is not an imported CRM source of this brand.",
      });
      return;
    }
  }

  let audience;
  try {
    [audience] = await db
      .insert(audiences)
      .values({
        orgId,
        brandId: parsed.data.brandId,
        name: parsed.data.name,
        provider: parsed.data.provider ?? null,
        apolloAudienceId: parsed.data.apolloAudienceId ?? null,
        crmUploadId: parsed.data.crmUploadId ?? null,
        // The offer this audience belongs to. Stored verbatim — brand-service
        // owns the entity, human-service defines no offer semantics and does
        // not resolve the id (same treatment as brandId; crmUploadId is
        // validated above only because it decides who a serve may reach).
        offerId: parsed.data.offerId ?? null,
        nlPrompt: parsed.data.nlPrompt ?? null,
        ...audienceTargetFields(parsed.data.nlPrompt),
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

  res.status(201).json({ audience: (await serializeAudiences([audience]))[0] });
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
      const { candidates, failedSegments } = await suggestAudiences(
        parsed.data.nlPrompt,
        parsed.data.brandId,
        buildIdentity(res),
        parsed.data.offerId ?? null
      );
      console.log(
        `[human-service] audience.suggest org=${res.locals.orgId} brand=${parsed.data.brandId} offer=${parsed.data.offerId ?? "none"} candidates=${candidates.length} failed=${failedSegments.length}`
      );
      res.json({ candidates, failedSegments });
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

// --- POST /orgs/audiences/split ---
// Target text -> up to 6 non-overlapping segments (name, sentence, icon) for the
// new-campaign modal. One writing call + one typed judgment via chat-service; no
// provider search, no counts, persists nothing. Needs x-user-id (chat-service).
router.post(
  "/orgs/audiences/split",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const parsed = SplitAudiencesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const startedAt = Date.now();
    try {
      const proposal = await proposeAudienceSplit(
        parsed.data.targetAudience,
        buildIdentity(res)
      );
      console.log(
        `[human-service] audience.split org=${res.locals.orgId} brand=${parsed.data.brandId} segments=${proposal.segments.length} axes=${proposal.axes.join("+") || "none"} ms=${Date.now() - startedAt}`
      );
      res.json(proposal);
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

// --- POST /orgs/audiences/split/confirm ---
// The segments the customer kept -> ACTIVE audiences under (brand, offer), all
// or nothing. Apollo filters are built right after, in the background (and
// inline on the first serve-next if the background build has not landed).
router.post(
  "/orgs/audiences/split/confirm",
  requireApiKey,
  requireOrgIdOnly,
  async (req, res) => {
    const parsed = ConfirmAudienceSplitRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const names = parsed.data.segments.map((s) => s.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      res.status(400).json({ error: "Segment names must be unique." });
      return;
    }
    const orgId = res.locals.orgId as string;
    // The customer's words become a PERSON-level target (who to write to, who
    // stays in around them, which functions are out) before they are stored as
    // nl_prompt, the sentence the pre-pay screen judges every candidate against.
    // Read against THIS offer, so the roles come from what it sells.
    let target: string | null = null;
    if (parsed.data.targetAudience) {
      try {
        target = await draftAudienceTarget({
          customerTarget: parsed.data.targetAudience,
          brandId: parsed.data.brandId,
          offerId: parsed.data.offerId,
          identity: buildIdentity(res),
        });
      } catch (err) {
        sendProviderError(res, err);
        return;
      }
      console.log(
        `[human-service] audience.target_drafted org=${orgId} brand=${parsed.data.brandId} offer=${parsed.data.offerId} target=${JSON.stringify(target)}`
      );
    }
    let created;
    try {
      created = await confirmAudienceSplit({
        orgId,
        userId: (res.locals.userId as string | undefined) ?? null,
        brandId: parsed.data.brandId,
        offerId: parsed.data.offerId,
        targetAudience: target,
        segments: parsed.data.segments,
      });
    } catch (err) {
      if (err instanceof SplitNameConflictError || isUniqueViolation(err)) {
        res.status(409).json({
          error:
            err instanceof SplitNameConflictError
              ? err.message
              : "An audience with this name already exists for this brand and offer.",
        });
        return;
      }
      throw err;
    }
    console.log(
      `[human-service] audience.split_confirm org=${orgId} brand=${parsed.data.brandId} offer=${parsed.data.offerId} created=${created.length}`
    );
    // Build each segment's Apollo filters now, in the background (org-billed
    // with this request's identity). serve-next builds inline if one has not
    // landed yet, so a confirmed segment is never active AND unservable.
    const buildIdentityForSplit = buildIdentity(res);
    for (const row of created) {
      void ensureApolloPointer(row, buildIdentityForSplit).catch((err) =>
        console.error(
          `[human-service] audience.pointer_build.failed org=${orgId} audience=${row.id}`,
          err
        )
      );
      // Each segment's own text (several segments share one nl_prompt), drafted
      // now in the background; serve-next drafts it inline if it has not landed.
      void ensureTargetText(row, buildIdentityForSplit).catch((err) =>
        console.error(
          `[human-service] audience.target_text.failed org=${orgId} audience=${row.id}`,
          err
        )
      );
    }
    res.status(201).json({ audiences: await serializeAudiences(created) });
  }
);

// --- POST /orgs/audiences/portfolio ---
// The launch-time portfolio for a brand + offer, derived from the ICP text the
// customer validated: the cold split (adopted when a pre-payment flow already
// confirmed it) plus one buying-signal audience per signal reaching 20+
// companies, all ACTIVE. Idempotent per (org, brand, offer). Needs x-user-id
// (chat-service / apollo-service key resolution and the launch's own run).
router.post(
  "/orgs/audiences/portfolio",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const parsed = LaunchAudiencePortfolioRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const orgId = res.locals.orgId as string;
    let result;
    try {
      result = await launchAudiencePortfolio({
        orgId,
        userId: res.locals.userId as string,
        brandId: parsed.data.brandId,
        offerId: parsed.data.offerId,
        icpText: parsed.data.targetAudience,
        identity: buildIdentity(res),
      });
    } catch (err) {
      if (err instanceof SplitNameConflictError || isUniqueViolation(err)) {
        res.status(409).json({
          error:
            err instanceof SplitNameConflictError
              ? err.message
              : "An audience with this name already exists for this brand and offer.",
        });
        return;
      }
      sendProviderError(res, err);
      return;
    }
    const serialized = await serializeAudiences(result.audiences.map((a) => a.row));
    res.json({
      portfolioId: result.portfolioId,
      status: result.status,
      brandId: parsed.data.brandId,
      offerId: parsed.data.offerId,
      replayed: result.replayed,
      target: result.target,
      audiences: result.audiences.map((a, i) => ({
        ...serialized[i],
        kind: a.kind,
        signal: a.signal,
        adopted: a.adopted,
      })),
      signals: result.signals,
    });
  }
);

// --- POST /orgs/audiences/signal (linkedin_engagement) ---
// apollo-service owns the criterion and validates it; its 4xx (malformed
// competitor pages, Apollo filters beside the signal) is relayed with its own
// status and body so the caller sees the producer's named error, not a 502.
router.post(
  "/orgs/audiences/signal",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const parsed = CreateLinkedinEngagementAudienceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const orgId = res.locals.orgId as string;
    let audience;
    try {
      audience = await createLinkedinEngagementAudience({
        orgId,
        userId: res.locals.userId as string,
        brandId: parsed.data.brandId,
        offerId: parsed.data.offerId ?? null,
        name: parsed.data.name,
        nlPrompt: parsed.data.nlPrompt,
        status: parsed.data.status ?? "active",
        windowDays: parsed.data.signal.windowDays,
        competitorPages: parsed.data.signal.competitorPages,
        baseFilters: parsed.data.filters ?? {},
        identity: { ...buildIdentity(res), brandIds: [parsed.data.brandId] },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error: "An audience with this name already exists for this brand and offer.",
        });
        return;
      }
      if (err instanceof ProviderError && err.status >= 400 && err.status < 500) {
        let upstream: unknown = err.body;
        try {
          upstream = JSON.parse(err.body);
        } catch {
          // non-JSON body: relay the text as-is
        }
        const named =
          upstream && typeof upstream === "object" && typeof (upstream as { error?: unknown }).error === "string"
            ? (upstream as { error: string }).error
            : err.body;
        res.status(err.status).json({ error: named, provider: "apollo", upstreamStatus: err.status, upstream });
        return;
      }
      sendProviderError(res, err);
      return;
    }
    res.status(201).json({ audience: (await serializeAudiences([audience]))[0] });
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
  const offerFilter = parsedQuery.data.offerId;
  const statusFilter = parsedQuery.data.status;

  const conditions = [eq(audiences.orgId, orgId)];
  if (brandFilter) conditions.push(eq(audiences.brandId, brandFilter));
  // Narrow to ONE offer when asked. No filter = every audience the org owns,
  // whatever offer it carries and including the offer-less ones, which is
  // exactly what this route returned before offers existed.
  if (offerFilter) conditions.push(eq(audiences.offerId, offerFilter));
  if (statusFilter) conditions.push(eq(audiences.status, statusFilter));
  // "deprecated" is an admin-only terminal state (retired apify audiences from
  // the apify→apollo migration). Hide it from the user dashboard by default —
  // only an explicit ?status=deprecated surfaces them (admin/audit).
  else conditions.push(ne(audiences.status, "deprecated"));
  // An audience is serveable only once it has a committed provider. The
  // active list feeds downstream serve-ranking (campaign-service / lead-service
  // pick a brand's top active audience to serve), so a provider-uncommitted row
  // (provider IS NULL — never counted, half-finished) must never surface as
  // active or serve-next 422s "no committed provider". Enforce serveability on
  // the active read.
  if (statusFilter === "active") conditions.push(isNotNull(audiences.provider));
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

  // Per-row "Size" / "Remaining" contactability, computed server-side from the
  // SAME 3-month suppression window the serve path enforces. Every list item
  // carries sizeCount / availableToContactCount / availableToContactPct so the
  // dashboard renders them straight from the wire (never client-computed).
  const contactability = await computeAudienceContactability(rows);

  res.json({
    audiences: rows.map((row) => {
      if (!contactability.has(row.id)) {
        // computeAudienceContactability returns an entry for every input row;
        // a miss is an invariant break, not a case to paper over — fail loud.
        throw new Error(
          `[human-service] audience.contactability missing for ${row.id}`
        );
      }
      const c = contactability.get(row.id);
      // null = pool UNKNOWN (linkedin_engagement before its first exhaustion):
      // the three figures are omitted, never served as 0 ("served out").
      return c ? { ...serializeAudience(row, c), ...c } : serializeAudience(row, null);
    }),
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
  res.json({ audience: (await serializeAudiences([audience]))[0] });
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
  if (parsed.data.nlPrompt !== undefined) {
    updates.nlPrompt = parsed.data.nlPrompt;
    // An audience that is not one of several has its nl_prompt AS its text, so
    // the text follows the edit. A segment target was drafted for this audience
    // alone and stays as written.
    const fields = audienceTargetFields(parsed.data.nlPrompt);
    updates.targetText = sql`case when ${audiences.targetTextOrigin} = 'segment_target' then ${audiences.targetText} else ${fields.targetText} end`;
    updates.targetTextOrigin = sql`case when ${audiences.targetTextOrigin} = 'segment_target' then ${audiences.targetTextOrigin} else ${fields.targetTextOrigin} end`;
  }

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

  res.json({ audience: (await serializeAudiences([updated]))[0] });
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
    // "deprecated" is terminal + admin-only: setting it is rejected by the
    // schema (400 above), and transitioning OUT of it is blocked here via the
    // `ne(status, "deprecated")` guard — a deprecated row simply doesn't match,
    // so a reactivation attempt returns 404 (it is hidden anyway). This is what
    // prevents a user from re-enabling a retired apify audience.
    const [updated] = await db
      .update(audiences)
      .set({ status: parsed.data.status, updatedAt: new Date() })
      .where(
        and(
          eq(audiences.id, req.params.id),
          eq(audiences.orgId, orgId),
          ne(audiences.status, "deprecated")
        )
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Audience not found" });
      return;
    }

    console.log(
      `[human-service] audience.status org=${orgId} audience=${updated.id} status=${updated.status}`
    );
    // Respond FIRST — the avatar must never block or fail the status flip.
    res.json({ audience: (await serializeAudiences([updated]))[0] });

    // On any transition to `active`, auto-generate the avatar IF the audience
    // has none yet — this route is the single chokepoint every activation
    // surface (chat set_audience_status, onboarding, manual UI) passes through.
    // Reuse the SAME org-billed path the manual avatar route uses
    // (generateAvatar + buildIdentity), so the avatar is billed to the org from
    // the inbound status request's identity headers. Idempotent: only fires when
    // there's no avatarUrl, so re-activating never double-bills. Fire-and-forget
    // (best-effort) — a generation failure is logged loud, never surfaced.
    if (updated.status === "active" && !updated.avatarUrl) {
      generateAvatar(
        orgId,
        updated.id,
        buildAvatarPrompt(updated),
        buildIdentity(res)
      ).catch((err) =>
        console.error(
          `[human-service] audience.status.avatar_failed org=${orgId} audience=${updated.id}`,
          err
        )
      );
    }
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
      // Pointer model: an apollo audience re-counts via apollo-service by its
      // stored pointer; a legacy/neutral audience keeps the dual free dry-run.
      const counts = await refreshAudienceCounts(audience, buildIdentity(res));
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
      res.json({ audience: (await serializeAudiences([updated]))[0] });
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

// --- GET /orgs/audiences/:id/preview ---
// A free sample of who the audience reaches (real companies + real people, no
// emails, no phones) for a visitor who has not signed up yet. Fetched once from
// apollo-service and kept on the row, so a reload never re-asks the provider.
// Needs x-user-id (apollo key resolution). Writes nothing that makes anyone a
// lead or a member.
router.get(
  "/orgs/audiences/:id/preview",
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
      res.json(await getAudiencePreview(audience, buildIdentity(res)));
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

// --- GET /orgs/audiences/:id/preview/email-checks ---
// Where the "can we reach them?" check stands for the preview's first people:
// per person, pending / found (verified or not) / not found, by which finder.
// Free: never runs a reveal. Never returns an address.
router.get(
  "/orgs/audiences/:id/preview/email-checks",
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
      res.json(await getPreviewEmailChecks(audience, buildIdentity(res)));
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

// --- POST /orgs/audiences/:id/preview/email-checks/next ---
// Resolve ONE more sampled person: apollo-service's billed reveal + email
// verification (cost declared there, against the caller's org), outcome stored,
// whole state returned. Call in a loop until `done`. At most
// PREVIEW_EMAIL_CHECK_SAMPLE reveals per audience, ever. Not a serve: no
// suppression, no membership. Never returns an address.
router.post(
  "/orgs/audiences/:id/preview/email-checks/next",
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
      res.json(await checkNextPreviewPerson(audience, buildIdentity(res)));
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

// --- GET /orgs/audiences/:id/preview/companies ---
// Up to 100 real companies the audience reaches (firmographics) + the one
// person to write to at each, masked, never an email. Built only as far as
// offset+limit needs, stored once per audience (the company data is a paid
// apollo-service call, declared there against the caller's org).
router.get(
  "/orgs/audiences/:id/preview/companies",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const q = PreviewCompaniesQuerySchema.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "Invalid query", details: q.error.flatten() });
      return;
    }
    const orgId = res.locals.orgId as string;
    const audience = await getAudienceInOrg(orgId, req.params.id);
    if (!audience) {
      res.status(404).json({ error: "Audience not found" });
      return;
    }
    try {
      res.json(
        await getAudiencePreviewCompanies(
          audience,
          buildIdentity(res),
          q.data.offset ?? 0,
          q.data.limit ?? PREVIEW_COMPANIES_DEFAULT_LIMIT
        )
      );
    } catch (err) {
      sendProviderError(res, err);
    }
  }
);

// --- GET /orgs/audiences/:id/preview/companies/email-checks ---
// Free read: per checkable company row, found / verified or still pending.
router.get(
  "/orgs/audiences/:id/preview/companies/email-checks",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const orgId = res.locals.orgId as string;
    const audience = await getAudienceInOrg(orgId, req.params.id);
    if (!audience) {
      res.status(404).json({ error: "Audience not found" });
      return;
    }
    res.json(await getCompanyRowEmailChecks(audience));
  }
);

// --- POST /orgs/audiences/:id/preview/companies/:index/email-check ---
// ONE billed reveal + verification for a company row's person (apollo-service
// declares the cost against the caller's org). Idempotent per row. Not a serve.
router.post(
  "/orgs/audiences/:id/preview/companies/:index/email-check",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) {
      res.status(400).json({ error: "index must be a non-negative integer" });
      return;
    }
    const orgId = res.locals.orgId as string;
    const audience = await getAudienceInOrg(orgId, req.params.id);
    if (!audience) {
      res.status(404).json({ error: "Audience not found" });
      return;
    }
    try {
      res.json(await checkCompanyRowEmail(audience, buildIdentity(res), index));
    } catch (err) {
      if (err instanceof PreviewCompanyRowError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      sendProviderError(res, err);
    }
  }
);

// --- POST /orgs/audiences/:id/serve-next ---
// The per-iteration lead primitive: return the NEXT unserved person of the
// audience (real provider match on its STORED canonical filters + provider),
// record it served (per-brand cross-provider suppression → never repeats), and
// signal exhaustion cleanly. Needs x-user-id (apollo/apify key resolution), so
// requireOrgAndUser. The audience's brand drives suppression — NOT a header.
router.post(
  "/orgs/audiences/:id/serve-next",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const orgId = res.locals.orgId as string;
    const audience = await getAudienceInOrg(orgId, req.params.id);
    if (!audience) {
      res.status(404).json({ error: "Audience not found" });
      return;
    }

    // Suppression is scoped to the audience's brand, taken from the stored row —
    // never the request headers (the caller serves "the next person of THIS
    // audience", whose brand is fixed at creation).
    const identity: Identity = {
      ...buildIdentity(res),
      brandIds: [audience.brandId],
    };

    // Opportunistically refresh the Size snapshot on serve, TTL-gated to 1h. The
    // serve does NOT read the count (only the list's Size / Remaining does), so
    // this is fire-and-forget + best-effort: a refresh failure must never fail the
    // serve (lead-service crash-loops on a bad serve). The re-count is free (dry-
    // run, no credits).
    // Skipped while the Apollo pointer is not built yet: serve-next builds it
    // (and its count) below, and a legacy dry-run on no filters means nothing.
    if (!needsApolloPointerBuild(audience)) void refreshAudienceCountIfStale(audience, identity).catch((err) =>
      console.error(
        `[human-service] audience.count_refresh_failed org=${orgId} audience=${audience.id}`,
        err
      )
    );

    try {
      const result = await serveNextPerson(audience, identity);
      console.log(
        `[human-service] audience.serve_next org=${orgId} audience=${audience.id} provider=${audience.provider} status=${result.status}`
      );
      res.json(result);
    } catch (err) {
      if (err instanceof AudienceNotServableError) {
        res.status(422).json({ error: err.message });
        return;
      }
      sendProviderError(res, err);
    }
  }
);

// --- POST /orgs/audiences/:id/avatar ---
// (Re)generate the audience's avatar via chat-service (which owns the cost) and
// persist the returned hosted URL on the audience. Optional `prompt`
// body lets the dashboard AI-chat tool steer the image; omitted ⟹ derive from
// the audience's descriptors. Needs x-user-id (chat-service key resolution).
router.post(
  "/orgs/audiences/:id/avatar",
  requireApiKey,
  requireOrgAndUser,
  async (req, res) => {
    const parsed = GenerateAudienceAvatarRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const orgId = res.locals.orgId as string;
    const audience = await getAudienceInOrg(orgId, req.params.id);
    if (!audience) {
      res.status(404).json({ error: "Audience not found" });
      return;
    }

    const prompt = parsed.data.prompt ?? buildAvatarPrompt(audience);
    try {
      const updated = await generateAvatar(
        orgId,
        audience.id,
        prompt,
        buildIdentity(res)
      );
      console.log(
        `[human-service] audience.avatar org=${orgId} audience=${audience.id}`
      );
      res.json({ audience: (await serializeAudiences([updated]))[0] });
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

// Serialize rows WITH their contactability, so every channel size served on any
// audience response is the same figure the list serves as sizeCount.
async function serializeAudiences(rows: Array<typeof audiences.$inferSelect>) {
  const contactability = await computeAudienceContactability(rows);
  return rows.map((row) => serializeAudience(row, contactability.get(row.id) ?? null));
}

// The lists derived from the audience's text, each with its size. Today one row
// holds at most one list; the shape is a list so a text can carry several.
function describeChannels(
  row: typeof audiences.$inferSelect,
  contact: AudienceContactabilityEntry
) {
  if (!row.provider) return [];
  const base = { channel: "cold_email" as const, audienceId: row.id };
  if (row.provider === "crm") {
    return [{ ...base, list: "crm_contacts" as const, signal: null, size: null, sizeUnknownReason: "not_counted" as const }];
  }
  const signal = readSignal(row.filters);
  if (row.provider === "apify") {
    return [{ ...base, list: "apify_search" as const, signal: null, size: contact?.sizeCount ?? null, sizeUnknownReason: contact ? null : ("not_counted" as const) }];
  }
  if (isLinkedinEngagementFilters(row.filters)) {
    return [{ ...base, list: "linkedin_engagement" as const, signal, size: contact?.sizeCount ?? null, sizeUnknownReason: contact ? null : ("unknown_until_walked" as const) }];
  }
  const built = !!row.apolloAudienceId || (!!row.filters && Object.keys(row.filters).length > 0);
  const list = signal ? ("apollo_buying_signal" as const) : ("apollo_search" as const);
  if (!built) {
    return [{ ...base, list, signal, size: null, sizeUnknownReason: "not_built_yet" as const }];
  }
  return [{ ...base, list, signal, size: contact?.sizeCount ?? null, sizeUnknownReason: contact ? null : ("not_counted" as const) }];
}

function readSignal(filters: unknown): { type: string; windowDays: number | null } | null {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return null;
  const s = (filters as Record<string, unknown>).buying_signal;
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const o = s as Record<string, unknown>;
  if (typeof o.type !== "string") return null;
  return { type: o.type, windowDays: typeof o.window_days === "number" ? o.window_days : null };
}

function serializeAudience(
  row: typeof audiences.$inferSelect,
  contact: AudienceContactabilityEntry
) {
  return {
    id: row.id,
    orgId: row.orgId,
    brandId: row.brandId,
    name: row.name,
    nlPrompt: row.nlPrompt,
    description: row.description,
    provider: row.provider,
    apolloAudienceId: row.apolloAudienceId,
    crmUploadId: row.crmUploadId,
    offerId: row.offerId,
    status: row.status,
    source: row.source,
    canonicalAudienceId: row.canonicalAudienceId,
    filters: row.filters,
    avatarUrl: row.avatarUrl,
    apolloCount: row.apolloCount,
    apifyCount: row.apifyCount,
    countedAt: row.countedAt ? row.countedAt.toISOString() : null,
    degraded: row.degraded,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    targetText: row.targetText,
    targetTextOrigin: row.targetTextOrigin as "segment_target" | "audience_target" | null,
    targetTextMissingReason: targetTextMissingReason(row),
    channels: describeChannels(row, contact),
  };
}

export default router;
