import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertOrg,
  insertHuman,
  insertMethodology,
} from "../helpers/test-db.js";

const app = createTestApp();
const headers = getAuthHeaders();

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("GET /humans/:id/methodology", () => {
  it("returns cached methodology", async () => {
    const org = await insertOrg({ appId: "test-app", orgId: "org-1" });
    const human = await insertHuman({
      orgInternalId: org.id,
      name: "Jane Expert",
      slug: "jane-expert",
      urls: ["https://jane.example.com"],
    });

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 14);

    await insertMethodology({
      humanId: human.id,
      frameworks: [
        {
          name: "Test Framework",
          description: "A testing framework",
          applicationContext: "Used for testing",
        },
      ],
      strategicPatterns: ["pattern1", "pattern2"],
      toneOfVoice: {
        register: "casual",
        pace: "fast",
        vocabulary: "simple",
        perspective: "first-person",
        examples: ["example1"],
      },
      persuasionStyle: {
        primary: "value-first",
        techniques: ["specificity"],
        callToAction: "Try it now",
      },
      contentSignatures: ["uses numbers"],
      avoids: ["jargon"],
      extractionModel: "claude-sonnet-4-20250514",
      sourceUrls: ["https://jane.example.com"],
      expiresAt: futureDate,
    });

    const res = await request(app)
      .get(`/humans/${human.id}/methodology`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.methodology.humanId).toBe(human.id);
    expect(res.body.methodology.frameworks).toHaveLength(1);
    expect(res.body.methodology.frameworks[0].name).toBe("Test Framework");
    expect(res.body.methodology.strategicPatterns).toEqual([
      "pattern1",
      "pattern2",
    ]);
    expect(res.body.methodology.toneOfVoice.register).toBe("casual");
    expect(res.body.methodology.persuasionStyle.primary).toBe("value-first");
    expect(res.body.isExpired).toBeUndefined();
  });

  it("flags expired methodology", async () => {
    const org = await insertOrg({ appId: "test-app", orgId: "org-1" });
    const human = await insertHuman({
      orgInternalId: org.id,
      name: "Jane Expert",
      slug: "jane-expert",
      urls: ["https://jane.example.com"],
    });

    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 1);

    await insertMethodology({
      humanId: human.id,
      extractionModel: "claude-sonnet-4-20250514",
      expiresAt: pastDate,
    });

    const res = await request(app)
      .get(`/humans/${human.id}/methodology`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.isExpired).toBe(true);
  });

  it("returns 404 when no methodology exists", async () => {
    const org = await insertOrg({ appId: "test-app", orgId: "org-1" });
    const human = await insertHuman({
      orgInternalId: org.id,
      name: "Jane Expert",
      slug: "jane-expert",
      urls: ["https://jane.example.com"],
    });

    const res = await request(app)
      .get(`/humans/${human.id}/methodology`)
      .set(headers);

    expect(res.status).toBe(404);
  });

  it("returns 404 when human does not exist", async () => {
    const res = await request(app)
      .get("/humans/00000000-0000-0000-0000-000000000000/methodology")
      .set(headers);

    expect(res.status).toBe(404);
  });
});

describe("POST /humans/:id/extract", () => {
  it("returns 404 when human does not exist", async () => {
    const res = await request(app)
      .post("/humans/00000000-0000-0000-0000-000000000000/extract")
      .set(headers)
      .send({
        appId: "test-app",
        orgId: "org-1",
        userId: "user-1",
        keySource: "app",
      });

    expect(res.status).toBe(404);
  });

  it("rejects missing required fields", async () => {
    const org = await insertOrg({ appId: "test-app", orgId: "org-1" });
    const human = await insertHuman({
      orgInternalId: org.id,
      name: "Jane Expert",
      slug: "jane-expert",
      urls: ["https://jane.example.com"],
    });

    const res = await request(app)
      .post(`/humans/${human.id}/extract`)
      .set(headers)
      .send({
        appId: "test-app",
        // missing orgId, userId, keySource
      });

    expect(res.status).toBe(400);
  });

  it("rejects invalid keySource", async () => {
    const org = await insertOrg({ appId: "test-app", orgId: "org-1" });
    const human = await insertHuman({
      orgInternalId: org.id,
      name: "Jane Expert",
      slug: "jane-expert",
      urls: ["https://jane.example.com"],
    });

    const res = await request(app)
      .post(`/humans/${human.id}/extract`)
      .set(headers)
      .send({
        appId: "test-app",
        orgId: "org-1",
        userId: "user-1",
        keySource: "invalid",
      });

    expect(res.status).toBe(400);
  });

  it("returns cached methodology when not expired and no forceRefresh", async () => {
    const org = await insertOrg({ appId: "test-app", orgId: "org-1" });
    const human = await insertHuman({
      orgInternalId: org.id,
      name: "Jane Expert",
      slug: "jane-expert",
      urls: ["https://jane.example.com"],
    });

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 14);

    await insertMethodology({
      humanId: human.id,
      frameworks: [
        {
          name: "Cached Framework",
          description: "Already cached",
          applicationContext: "Testing cache",
        },
      ],
      extractionModel: "claude-sonnet-4-20250514",
      expiresAt: futureDate,
    });

    const res = await request(app)
      .post(`/humans/${human.id}/extract`)
      .set(headers)
      .send({
        appId: "test-app",
        orgId: "org-1",
        userId: "user-1",
        keySource: "app",
      });

    expect(res.status).toBe(200);
    expect(res.body.pagesScraped).toBe(0);
    expect(res.body.methodology.frameworks[0].name).toBe("Cached Framework");
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/humans/00000000-0000-0000-0000-000000000000/extract")
      .send({
        appId: "test-app",
        orgId: "org-1",
        userId: "user-1",
        keySource: "app",
      });

    expect(res.status).toBe(401);
  });
});
