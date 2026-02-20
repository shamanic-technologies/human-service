import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { humanProfiles } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  CreateProfileRequestSchema,
  ScrapeRequestSchema,
} from "../schemas.js";
import { scrapeUrls } from "../services/scraper.js";
import { extractProfile } from "../services/extractor.js";
import { resolveApiKey } from "../services/keys.js";
import { createChildRun, addCosts, completeRun } from "../services/runs.js";

const router = Router();

// POST /profiles — Create or update a profile
router.post("/profiles", requireApiKey, async (req, res) => {
  const parsed = CreateProfileRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { appId, orgId, userId, name, urls, maxPages, cacheTtlHours } =
    parsed.data;

  try {
    // Upsert by (appId, orgId)
    const existing = await db
      .select()
      .from(humanProfiles)
      .where(
        and(
          eq(humanProfiles.appId, appId),
          orgId ? eq(humanProfiles.orgId, orgId) : undefined
        )
      )
      .limit(1);

    let profile;

    if (existing.length > 0) {
      const [updated] = await db
        .update(humanProfiles)
        .set({
          name,
          urls,
          userId: userId ?? existing[0].userId,
          ...(maxPages !== undefined ? { maxPages } : {}),
          ...(cacheTtlHours !== undefined ? { cacheTtlHours } : {}),
          updatedAt: new Date(),
        })
        .where(eq(humanProfiles.id, existing[0].id))
        .returning();
      profile = updated;
    } else {
      const [created] = await db
        .insert(humanProfiles)
        .values({
          appId,
          orgId,
          userId,
          name,
          urls,
          maxPages: maxPages ?? 3,
          cacheTtlHours: cacheTtlHours ?? 24,
        })
        .returning();
      profile = created;
    }

    res.json({ profile: serializeProfile(profile) });
  } catch (err) {
    console.error("Error creating profile:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /profiles/:orgId — Get cached profile
router.get("/profiles/:orgId", requireApiKey, async (req, res) => {
  const { orgId } = req.params;
  const appId = req.query.appId as string;

  if (!appId) {
    res.status(400).json({ error: "appId query parameter is required" });
    return;
  }

  try {
    const [profile] = await db
      .select()
      .from(humanProfiles)
      .where(
        and(
          eq(humanProfiles.appId, appId),
          eq(humanProfiles.orgId, orgId)
        )
      )
      .limit(1);

    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    const isStale = isCacheStale(profile.lastScrapedAt, profile.cacheTtlHours);

    res.json({
      profile: serializeProfile(profile),
      ...(isStale ? { isStale: true } : {}),
    });
  } catch (err) {
    console.error("Error getting profile:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /profiles/:orgId/scrape — Trigger scrape
router.post("/profiles/:orgId/scrape", requireApiKey, async (req, res) => {
  const { orgId } = req.params;
  const parsed = ScrapeRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { appId, runId, keySource, maxPages: maxPagesOverride, forceRefresh } =
    parsed.data;

  try {
    const [profile] = await db
      .select()
      .from(humanProfiles)
      .where(
        and(
          eq(humanProfiles.appId, appId),
          eq(humanProfiles.orgId, orgId)
        )
      )
      .limit(1);

    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    // Check cache freshness
    if (
      !forceRefresh &&
      !isCacheStale(profile.lastScrapedAt, profile.cacheTtlHours)
    ) {
      res.json({
        profile: serializeProfile(profile),
        pagesScraped: 0,
      });
      return;
    }

    // Create child run for cost tracking
    const childRunId = await createChildRun({
      appId,
      clerkOrgId: orgId,
      parentRunId: runId,
      taskName: "scrape-profile",
    });

    const effectiveMaxPages = maxPagesOverride ?? profile.maxPages;

    // Resolve API keys
    const firecrawlKey = await resolveApiKey(
      "firecrawl",
      keySource,
      appId,
      parsed.data.orgId
    );
    const anthropicKey = await resolveApiKey(
      "anthropic",
      keySource,
      appId,
      parsed.data.orgId
    );

    // Fallback to env vars
    const effectiveFirecrawlKey = firecrawlKey || process.env.FIRECRAWL_API_KEY;
    const effectiveAnthropicKey =
      anthropicKey || process.env.ANTHROPIC_API_KEY || "";

    // Scrape pages
    const scrapeResult = await scrapeUrls({
      urls: profile.urls,
      maxPages: effectiveMaxPages,
      firecrawlApiKey: effectiveFirecrawlKey || undefined,
    });

    // Track scraping costs
    if (childRunId && effectiveFirecrawlKey && scrapeResult.pages.length > 0) {
      await addCosts(childRunId, [
        {
          costName: "firecrawl-scrape",
          quantity: scrapeResult.pages.length,
        },
      ]);
    }

    // AI extraction
    let extracted = {
      writingStyle: profile.writingStyle,
      bio: profile.bio,
      topics: profile.topics,
      tone: profile.tone,
      vocabulary: profile.vocabulary,
    };

    if (effectiveAnthropicKey && scrapeResult.pages.length > 0) {
      const extractionResult = await extractProfile(
        profile.name,
        scrapeResult.pages,
        effectiveAnthropicKey
      );
      extracted = {
        writingStyle: extractionResult.profile.writingStyle,
        bio: extractionResult.profile.bio,
        topics: extractionResult.profile.topics,
        tone: extractionResult.profile.tone,
        vocabulary: extractionResult.profile.vocabulary,
      };

      // Track AI costs
      if (childRunId) {
        await addCosts(childRunId, [
          {
            costName: "anthropic-input-tokens",
            quantity: extractionResult.inputTokens,
          },
          {
            costName: "anthropic-output-tokens",
            quantity: extractionResult.outputTokens,
          },
        ]);
      }
    }

    // Update profile
    const [updated] = await db
      .update(humanProfiles)
      .set({
        scrapedPages: scrapeResult.pages,
        writingStyle: extracted.writingStyle,
        bio: extracted.bio,
        topics: extracted.topics,
        tone: extracted.tone,
        vocabulary: extracted.vocabulary,
        lastScrapedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(humanProfiles.id, profile.id))
      .returning();

    if (childRunId) {
      await completeRun(childRunId, "completed");
    }

    res.json({
      profile: serializeProfile(updated),
      pagesScraped: scrapeResult.pages.length,
    });
  } catch (err) {
    console.error("Error scraping profile:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

function isCacheStale(
  lastScrapedAt: Date | null,
  cacheTtlHours: number
): boolean {
  if (!lastScrapedAt) return true;
  const now = new Date();
  const staleAfter = new Date(
    lastScrapedAt.getTime() + cacheTtlHours * 60 * 60 * 1000
  );
  return now > staleAfter;
}

function serializeProfile(profile: typeof humanProfiles.$inferSelect) {
  return {
    ...profile,
    lastScrapedAt: profile.lastScrapedAt?.toISOString() ?? null,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

export default router;
