import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertProfile } from "../helpers/test-db.js";

describe("Profile endpoints", () => {
  const app = createTestApp();
  const headers = getAuthHeaders();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await closeDb();
  });

  describe("GET /health", () => {
    it("returns ok", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.service).toBe("human");
    });
  });

  describe("POST /profiles", () => {
    it("creates a new profile", async () => {
      const res = await request(app)
        .post("/profiles")
        .set(headers)
        .send({
          appId: "test-app",
          orgId: "org-1",
          userId: "user-1",
          keySource: "app",
          runId: "run-1",
          name: "Kevin Lourd",
          urls: ["https://kevinlourd.com"],
        });

      expect(res.status).toBe(200);
      expect(res.body.profile.name).toBe("Kevin Lourd");
      expect(res.body.profile.urls).toEqual(["https://kevinlourd.com"]);
      expect(res.body.profile.appId).toBe("test-app");
      expect(res.body.profile.orgId).toBe("org-1");
      expect(res.body.profile.userId).toBe("user-1");
      expect(res.body.profile.maxPages).toBe(3);
    });

    it("upserts an existing profile by appId+orgId", async () => {
      await insertProfile({
        appId: "test-app",
        orgId: "org-1",
        name: "Old Name",
        urls: ["https://old.com"],
      });

      const res = await request(app)
        .post("/profiles")
        .set(headers)
        .send({
          appId: "test-app",
          orgId: "org-1",
          userId: "user-1",
          keySource: "app",
          runId: "run-1",
          name: "New Name",
          urls: ["https://new.com"],
          maxPages: 5,
        });

      expect(res.status).toBe(200);
      expect(res.body.profile.name).toBe("New Name");
      expect(res.body.profile.urls).toEqual(["https://new.com"]);
      expect(res.body.profile.maxPages).toBe(5);
    });

    it("rejects missing name", async () => {
      const res = await request(app)
        .post("/profiles")
        .set(headers)
        .send({
          appId: "test-app",
          orgId: "org-1",
          userId: "user-1",
          keySource: "app",
          runId: "run-1",
          urls: ["https://example.com"],
        });

      expect(res.status).toBe(400);
    });

    it("rejects missing orgId", async () => {
      const res = await request(app)
        .post("/profiles")
        .set(headers)
        .send({
          appId: "test-app",
          userId: "user-1",
          keySource: "app",
          runId: "run-1",
          name: "Test",
          urls: ["https://example.com"],
        });

      expect(res.status).toBe(400);
    });

    it("rejects requests without API key", async () => {
      const res = await request(app)
        .post("/profiles")
        .send({
          appId: "test-app",
          orgId: "org-1",
          userId: "user-1",
          keySource: "app",
          runId: "run-1",
          name: "Test",
          urls: ["https://example.com"],
        });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /profiles/:orgId", () => {
    it("returns cached profile", async () => {
      await insertProfile({
        appId: "test-app",
        orgId: "org-1",
        name: "Kevin",
        urls: ["https://kevinlourd.com"],
        lastScrapedAt: new Date(),
        bio: "Test bio",
      });

      const res = await request(app)
        .get("/profiles/org-1")
        .set(headers)
        .query({ appId: "test-app", userId: "user-1" });

      expect(res.status).toBe(200);
      expect(res.body.profile.name).toBe("Kevin");
      expect(res.body.profile.bio).toBe("Test bio");
      expect(res.body.isStale).toBeUndefined();
    });

    it("indicates stale cache", async () => {
      const staleDate = new Date();
      staleDate.setHours(staleDate.getHours() - 25);

      await insertProfile({
        appId: "test-app",
        orgId: "org-1",
        name: "Kevin",
        urls: ["https://kevinlourd.com"],
        lastScrapedAt: staleDate,
        cacheTtlHours: 24,
      });

      const res = await request(app)
        .get("/profiles/org-1")
        .set(headers)
        .query({ appId: "test-app", userId: "user-1" });

      expect(res.status).toBe(200);
      expect(res.body.isStale).toBe(true);
    });

    it("returns 404 for missing profile", async () => {
      const res = await request(app)
        .get("/profiles/nonexistent")
        .set(headers)
        .query({ appId: "test-app", userId: "user-1" });

      expect(res.status).toBe(404);
    });

    it("requires appId and userId query params", async () => {
      const res = await request(app)
        .get("/profiles/org-1")
        .set(headers);

      expect(res.status).toBe(400);
    });
  });

  describe("POST /profiles/:orgId/scrape", () => {
    it("returns cached data without re-scraping when fresh", async () => {
      await insertProfile({
        appId: "test-app",
        orgId: "org-1",
        name: "Kevin",
        urls: ["https://kevinlourd.com"],
        lastScrapedAt: new Date(),
        cacheTtlHours: 24,
        bio: "Cached bio",
        scrapedPages: [
          {
            url: "https://kevinlourd.com",
            title: "Kevin",
            content: "test",
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
        });

      expect(res.status).toBe(200);
      expect(res.body.pagesScraped).toBe(0);
      expect(res.body.profile.bio).toBe("Cached bio");
    });

    it("returns 404 for nonexistent profile", async () => {
      const res = await request(app)
        .post("/profiles/nonexistent/scrape")
        .set(headers)
        .send({
          appId: "test-app",
          orgId: "nonexistent",
          userId: "user-1",
          keySource: "app",
          runId: "run-1",
        });

      expect(res.status).toBe(404);
    });

    it("rejects invalid keySource", async () => {
      await insertProfile({
        appId: "test-app",
        orgId: "org-1",
        name: "Kevin",
        urls: ["https://kevinlourd.com"],
      });

      const res = await request(app)
        .post("/profiles/org-1/scrape")
        .set(headers)
        .send({
          appId: "test-app",
          orgId: "org-1",
          userId: "user-1",
          keySource: "invalid",
          runId: "run-1",
        });

      expect(res.status).toBe(400);
    });
  });
});
