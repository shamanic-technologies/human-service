import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertProfile } from "../helpers/test-db.js";

// Mock the scraper and extractor modules
vi.mock("../../src/services/scraper.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/services/scraper.js")>();
  return {
    ...original,
    scrapeUrls: vi.fn(),
  };
});

vi.mock("../../src/services/extractor.js", () => ({
  extractProfile: vi.fn(),
}));

vi.mock("../../src/services/keys.js", () => ({
  resolveApiKey: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/services/runs.js", () => ({
  createChildRun: vi.fn().mockResolvedValue(null),
  addCosts: vi.fn().mockResolvedValue(undefined),
  completeRun: vi.fn().mockResolvedValue(undefined),
}));

import { scrapeUrls } from "../../src/services/scraper.js";
import { extractProfile } from "../../src/services/extractor.js";
import { resolveApiKey } from "../../src/services/keys.js";

const mockScrapeUrls = vi.mocked(scrapeUrls);
const mockExtractProfile = vi.mocked(extractProfile);
const mockResolveApiKey = vi.mocked(resolveApiKey);

describe("Scrape integration", () => {
  const app = createTestApp();
  const headers = getAuthHeaders();

  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("scrapes pages and extracts profile when cache is stale", async () => {
    const staleDate = new Date();
    staleDate.setHours(staleDate.getHours() - 25);

    await insertProfile({
      appId: "test-app",
      orgId: "org-1",
      name: "Kevin Lourd",
      urls: ["https://kevinlourd.com"],
      lastScrapedAt: staleDate,
    });

    mockScrapeUrls.mockResolvedValue({
      pages: [
        {
          url: "https://kevinlourd.com",
          title: "Kevin Lourd",
          content: "Kevin is an entrepreneur...",
          scrapedAt: new Date().toISOString(),
        },
        {
          url: "https://kevinlourd.com/about",
          title: "About Kevin",
          content: "Background info...",
          scrapedAt: new Date().toISOString(),
        },
      ],
    });

    mockExtractProfile.mockResolvedValue({
      profile: {
        writingStyle: "Conversational, first-person",
        bio: "Kevin is a tech entrepreneur",
        topics: ["AI", "entrepreneurship"],
        tone: "Authentic and direct",
        vocabulary: "innovative, disruptive",
      },
      inputTokens: 1500,
      outputTokens: 300,
    });

    // Mock key-service returning an anthropic key
    mockResolveApiKey.mockImplementation(async (provider) => {
      if (provider === "anthropic") return "test-anthropic-key";
      return null;
    });

    const res = await request(app)
      .post("/profiles/org-1/scrape")
      .set(headers)
      .send({
        appId: "test-app",
        orgId: "org-1",
        userId: "user-1",
        keySource: "app",
        runId: "run-1",
      });

    expect(res.status).toBe(200);
    expect(res.body.pagesScraped).toBe(2);
    expect(res.body.profile.writingStyle).toBe("Conversational, first-person");
    expect(res.body.profile.bio).toBe("Kevin is a tech entrepreneur");
    expect(res.body.profile.topics).toEqual(["AI", "entrepreneurship"]);
    expect(res.body.profile.tone).toBe("Authentic and direct");

    expect(mockScrapeUrls).toHaveBeenCalledWith({
      urls: ["https://kevinlourd.com"],
      maxPages: 3,
      firecrawlApiKey: undefined,
    });

    expect(mockExtractProfile).toHaveBeenCalledWith(
      "Kevin Lourd",
      expect.any(Array),
      "test-anthropic-key"
    );
  });

  it("force refreshes even with fresh cache", async () => {
    await insertProfile({
      appId: "test-app",
      orgId: "org-1",
      name: "Kevin",
      urls: ["https://kevinlourd.com"],
      lastScrapedAt: new Date(),
      cacheTtlHours: 24,
    });

    mockScrapeUrls.mockResolvedValue({
      pages: [
        {
          url: "https://kevinlourd.com",
          title: "Kevin",
          content: "Fresh content",
          scrapedAt: new Date().toISOString(),
        },
      ],
    });

    const res = await request(app)
      .post("/profiles/org-1/scrape")
      .set(headers)
      .send({
        appId: "test-app",
        orgId: "org-1",
        userId: "user-1",
        keySource: "app",
        runId: "run-1",
        forceRefresh: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.pagesScraped).toBe(1);
    expect(mockScrapeUrls).toHaveBeenCalled();
  });

  it("respects maxPages override", async () => {
    const staleDate = new Date();
    staleDate.setHours(staleDate.getHours() - 25);

    await insertProfile({
      appId: "test-app",
      orgId: "org-1",
      name: "Kevin",
      urls: ["https://kevinlourd.com"],
      lastScrapedAt: staleDate,
      maxPages: 3,
    });

    mockScrapeUrls.mockResolvedValue({ pages: [] });

    const res = await request(app)
      .post("/profiles/org-1/scrape")
      .set(headers)
      .send({
        appId: "test-app",
        orgId: "org-1",
        userId: "user-1",
        keySource: "app",
        runId: "run-1",
        maxPages: 5,
      });

    expect(res.status).toBe(200);
    expect(mockScrapeUrls).toHaveBeenCalledWith(
      expect.objectContaining({ maxPages: 5 })
    );
  });

  it("scrapes when profile was never scraped before", async () => {
    await insertProfile({
      appId: "test-app",
      orgId: "org-1",
      name: "Kevin",
      urls: ["https://kevinlourd.com"],
      // no lastScrapedAt = never scraped = stale
    });

    mockScrapeUrls.mockResolvedValue({ pages: [] });

    const res = await request(app)
      .post("/profiles/org-1/scrape")
      .set(headers)
      .send({
        appId: "test-app",
        orgId: "org-1",
        userId: "user-1",
        keySource: "app",
        runId: "run-1",
      });

    expect(res.status).toBe(200);
    expect(mockScrapeUrls).toHaveBeenCalled();
  });
});
