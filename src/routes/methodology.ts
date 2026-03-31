import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { humans, humanMethodologies } from "../db/schema.js";
import { requireApiKey, requireIdentity, getWorkflowTracking } from "../middleware/auth.js";
import { ExtractRequestSchema } from "../schemas.js";
import { resolveApiKey } from "../services/keys.js";
import { createRun, addCosts, completeRun } from "../services/runs.js";
import { mapSiteUrls, scrapePage } from "../services/scraping.js";
import { rankPages } from "../services/url-utils.js";
import { extractMethodology } from "../services/extractor.js";

const router = Router();

// GET /humans/:id/methodology — Get cached methodology
router.get(
  "/humans/:id/methodology",
  requireApiKey,
  requireIdentity,
  async (req, res) => {
    const { id } = req.params;

    try {
      const [human] = await db
        .select()
        .from(humans)
        .where(eq(humans.id, id))
        .limit(1);

      if (!human) {
        res.status(404).json({ error: "Human not found" });
        return;
      }

      const [methodology] = await db
        .select()
        .from(humanMethodologies)
        .where(eq(humanMethodologies.humanId, id))
        .limit(1);

      if (!methodology) {
        res.status(404).json({ error: "Methodology not found. Run POST /humans/:id/extract first." });
        return;
      }

      const isExpired =
        methodology.expiresAt !== null && methodology.expiresAt < new Date();

      res.json({
        methodology: serializeMethodology(methodology),
        ...(isExpired ? { isExpired: true } : {}),
      });
    } catch (err) {
      console.error("Error getting methodology:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /humans/:id/extract — Trigger scrape + AI extraction
router.post(
  "/humans/:id/extract",
  requireApiKey,
  requireIdentity,
  async (req, res) => {
    const { id } = req.params;
    const parsed = ExtractRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { orgId, userId, runId } = res.locals as { orgId: string; userId: string; runId: string };
    const workflowTracking = getWorkflowTracking(res.locals);
    const { forceRefresh } = parsed.data;

    try {
      const [human] = await db
        .select()
        .from(humans)
        .where(eq(humans.id, id))
        .limit(1);

      if (!human) {
        res.status(404).json({ error: "Human not found" });
        return;
      }

      // Check cache
      if (!forceRefresh) {
        const [existing] = await db
          .select()
          .from(humanMethodologies)
          .where(eq(humanMethodologies.humanId, id))
          .limit(1);

        if (
          existing &&
          existing.expiresAt !== null &&
          existing.expiresAt > new Date()
        ) {
          res.json({
            human: serializeHumanBasic(human),
            methodology: serializeMethodology(existing),
            pagesScraped: 0,
          });
          return;
        }
      }

      // Create our own run with the caller's runId as parent
      const childRunId = await createRun({
        orgId,
        userId,
        parentRunId: runId,
        taskName: "methodology-extraction",
        workflowTracking,
      });

      const callerContext = { method: "POST", path: `/humans/${id}/extract` };

      // Use our child run ID for downstream calls (not the caller's run ID)
      const effectiveRunId = childRunId ?? runId;

      // Resolve Anthropic key (key-service decides source)
      const resolved = await resolveApiKey(
        "anthropic",
        { orgId, userId, runId: effectiveRunId, workflowTracking },
        callerContext
      );

      // Pass our own runId downstream (not the one we received)
      const tracking = { orgId, userId, runId: effectiveRunId, workflowTracking };

      // Discover URLs via scraping-service
      const allUrls: string[] = [];
      for (const baseUrl of human.urls) {
        const mapped = await mapSiteUrls(baseUrl, tracking, 50);
        allUrls.push(...mapped.urls);
      }

      // Select top pages
      const maxPages = human.maxPages;
      const selectedUrls = rankPages(
        [...new Set(allUrls)],
        maxPages
      );

      // Scrape pages concurrently
      const scrapePromises = selectedUrls.map((url) =>
        scrapePage(url, tracking)
      );
      const scrapeResults = await Promise.all(scrapePromises);
      const pages = scrapeResults.filter(
        (r): r is NonNullable<typeof r> => r !== null
      );

      // AI extraction
      let extractedData = null;
      if (resolved?.key && pages.length > 0) {
        const extraction = await extractMethodology(
          human.name,
          pages,
          resolved.key
        );
        extractedData = extraction.data;

        // Track AI costs with costSource from key-service
        if (childRunId) {
          await addCosts(childRunId, [
            {
              costName: "anthropic-sonnet-4-20250514-tokens-input",
              costSource: resolved.keySource,
              quantity: extraction.inputTokens,
            },
            {
              costName: "anthropic-sonnet-4-20250514-tokens-output",
              costSource: resolved.keySource,
              quantity: extraction.outputTokens,
            },
          ], { orgId, userId, workflowTracking });
        }
      }

      // Update human with extracted bio/expertise/knownFor
      if (extractedData) {
        await db
          .update(humans)
          .set({
            bio: extractedData.bio || human.bio,
            expertise: extractedData.expertise.length > 0
              ? extractedData.expertise
              : human.expertise,
            knownFor: extractedData.knownFor || human.knownFor,
            updatedAt: new Date(),
          })
          .where(eq(humans.id, id));
      }

      // Upsert methodology with 14-day TTL
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 14);

      const sourceUrls = pages.map((p) => p.url);

      const methodologyValues = {
        humanId: id,
        frameworks: extractedData?.frameworks ?? null,
        strategicPatterns: extractedData?.strategicPatterns ?? null,
        toneOfVoice: extractedData?.toneOfVoice ?? null,
        persuasionStyle: extractedData?.persuasionStyle ?? null,
        contentSignatures: extractedData?.contentSignatures ?? null,
        avoids: extractedData?.avoids ?? null,
        extractionModel: resolved?.key ? "claude-sonnet-4-20250514" : null,
        sourceUrls,
        extractedAt: new Date(),
        expiresAt,
        updatedAt: new Date(),
        campaignId: workflowTracking.campaignId ?? null,
        brandIds: workflowTracking.brandIds?.length ? workflowTracking.brandIds : null,
        workflowSlug: workflowTracking.workflowSlug ?? null,
      };

      // Check if methodology exists for upsert
      const [existingMethodology] = await db
        .select({ id: humanMethodologies.id })
        .from(humanMethodologies)
        .where(eq(humanMethodologies.humanId, id))
        .limit(1);

      let methodology;
      if (existingMethodology) {
        const [updated] = await db
          .update(humanMethodologies)
          .set(methodologyValues)
          .where(eq(humanMethodologies.id, existingMethodology.id))
          .returning();
        methodology = updated;
      } else {
        const [inserted] = await db
          .insert(humanMethodologies)
          .values(methodologyValues)
          .returning();
        methodology = inserted;
      }

      if (childRunId) {
        await completeRun(childRunId, "completed", { orgId, userId, workflowTracking });
      }

      // Re-fetch human to get updated fields
      const [updatedHuman] = await db
        .select()
        .from(humans)
        .where(eq(humans.id, id))
        .limit(1);

      res.json({
        human: serializeHumanBasic(updatedHuman),
        methodology: serializeMethodology(methodology),
        pagesScraped: pages.length,
      });
    } catch (err) {
      console.error("Error extracting methodology:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

function serializeHumanBasic(human: typeof humans.$inferSelect) {
  return {
    id: human.id,
    name: human.name,
    slug: human.slug,
    bio: human.bio,
    expertise: human.expertise,
    knownFor: human.knownFor,
    imageUrl: human.imageUrl,
    createdAt: human.createdAt.toISOString(),
    updatedAt: human.updatedAt.toISOString(),
  };
}

function serializeMethodology(
  m: typeof humanMethodologies.$inferSelect
) {
  return {
    humanId: m.humanId,
    frameworks: m.frameworks,
    strategicPatterns: m.strategicPatterns,
    toneOfVoice: m.toneOfVoice,
    persuasionStyle: m.persuasionStyle,
    contentSignatures: m.contentSignatures,
    avoids: m.avoids,
    extractionModel: m.extractionModel,
    extractedAt: m.extractedAt?.toISOString() ?? null,
  };
}

export default router;
