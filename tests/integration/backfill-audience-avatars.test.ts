import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const app = createTestApp();
const apiKeyHeader = {
  "X-API-Key": "test-api-key",
  "Content-Type": "application/json",
};

const ORG = "a0000000-0000-4000-8000-000000000001";
const BRAND = "b0000000-0000-4000-8000-00000000000a";
const USER = "a0000000-0000-4000-8000-000000000002";
const NO_AV_A = "c0000000-0000-4000-8000-000000000001";
const NO_AV_B = "c0000000-0000-4000-8000-000000000002";
const HAS_DATA_URI = "c0000000-0000-4000-8000-000000000003";
const NO_USER = "c0000000-0000-4000-8000-000000000004";
const DEPRECATED = "c0000000-0000-4000-8000-000000000005";
const HAS_HTTP = "c0000000-0000-4000-8000-000000000006";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

function imageOk() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ imageBase64: "AAAA", mimeType: "image/png", model: "img", tokensInput: 1, tokensOutput: 1 }),
    text: async () => "",
  };
}

function uploadOk(url = "https://cdn.test/audiences/avatar.png") {
  return {
    ok: true,
    status: 200,
    json: async () => ({ id: "file-1", url, size: 4, contentType: "image/png" }),
    text: async () => "",
  };
}

async function seed() {
  await db.insert(audiences).values([
    { id: NO_AV_A, orgId: ORG, brandId: BRAND, name: "No Avatar A", status: "active", createdByUserId: USER },
    { id: NO_AV_B, orgId: ORG, brandId: BRAND, name: "No Avatar B", status: "suggested", createdByUserId: USER },
    { id: HAS_DATA_URI, orgId: ORG, brandId: BRAND, name: "Has Data Uri", status: "active", createdByUserId: USER, avatarUrl: "data:image/png;base64,WFhYWA==" },
    { id: NO_USER, orgId: ORG, brandId: BRAND, name: "No User", status: "active", createdByUserId: null },
    { id: DEPRECATED, orgId: ORG, brandId: BRAND, name: "Deprecated", status: "deprecated", createdByUserId: USER },
    { id: HAS_HTTP, orgId: ORG, brandId: BRAND, name: "Has HTTP", status: "active", createdByUserId: USER, avatarUrl: "https://cdn.test/existing.png" },
  ]);
}

beforeEach(async () => {
  fetchSpy.mockReset();
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  process.env.CLOUDFLARE_SERVICE_URL = "http://cloudflare:8080";
  process.env.CLOUDFLARE_SERVICE_API_KEY = "cloudflare-key";
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /internal/backfill-audience-avatars", () => {
  it("dry-run counts live null and data URI rows, calls nothing", async () => {
    await seed();
    fetchSpy.mockImplementation(async () => imageOk());

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.scanned).toBe(4); // three null rows + one data URI row (HTTP/deprecated excluded)
    expect(res.body.skippedNoUser).toBeUndefined();
    expect(res.body.wouldFill).toBe(4);
    expect(res.body.filled).toBe(0);
    expect(res.body.sample).toHaveLength(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("real run generates null avatars, converts data URIs to Cloudflare URLs, and is idempotent", async () => {
    await seed();
    const uploadBodies: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation(async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
      if (String(url).endsWith("/internal/platform-images/generate")) return imageOk();
      if (String(url).endsWith("/internal/upload/base64")) {
        uploadBodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
        expect(init?.headers?.["x-service-name"]).toBe("human-service");
        return uploadOk(`https://cdn.test/audiences/${uploadBodies.length}.png`);
      }
      throw new Error("unexpected url " + url);
    });

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.filled).toBe(4);
    expect(res.body.failed).toEqual([]);
    expect(uploadBodies).toHaveLength(4);

    const [a] = await db
      .select({ avatarUrl: audiences.avatarUrl })
      .from(audiences)
      .where(eq(audiences.id, NO_AV_A));
    expect(a.avatarUrl).toBe("https://cdn.test/audiences/1.png");

    // Pre-existing data URI converted.
    const [h] = await db
      .select({ avatarUrl: audiences.avatarUrl })
      .from(audiences)
      .where(eq(audiences.id, HAS_DATA_URI));
    expect(h.avatarUrl).toMatch(/^https:\/\/cdn\.test\/audiences\/\d+\.png$/);
    expect(uploadBodies.some((b) => b.contentBase64 === "WFhYWA==" && b.contentType === "image/png")).toBe(true);

    // Pre-existing HTTP avatar untouched.
    const [existingHttp] = await db
      .select({ avatarUrl: audiences.avatarUrl })
      .from(audiences)
      .where(eq(audiences.id, HAS_HTTP));
    expect(existingHttp.avatarUrl).toBe("https://cdn.test/existing.png");

    // NO_USER IS filled now (platform path needs no user).
    const [n] = await db
      .select({ avatarUrl: audiences.avatarUrl })
      .from(audiences)
      .where(eq(audiences.id, NO_USER));
    expect(n.avatarUrl).toMatch(/^https:\/\/cdn\.test\/audiences\/\d+\.png$/);

    // Re-run: no null or data URI live rows left.
    const reRun = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false")
      .set(apiKeyHeader);
    expect(reRun.body.scanned).toBe(0);
    expect(reRun.body.filled).toBe(0);
  });

  it("a per-row Cloudflare upload failure is reported, others still fill", async () => {
    await seed();
    let call = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/internal/platform-images/generate")) return imageOk();
      if (String(url).endsWith("/internal/upload/base64")) {
        call++;
        if (call === 1) return { ok: false, status: 502, json: async () => ({}), text: async () => "cloudflare blip" };
        return uploadOk();
      }
      throw new Error("unexpected url " + url);
    });

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.filled).toBe(3);
    expect(res.body.failed).toHaveLength(1);
  });

  it("stores platform chat-service URL responses directly without re-uploading generated avatars", async () => {
    await seed();
    let uploads = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/internal/platform-images/generate")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: "https://cdn.test/generated-direct.png", mimeType: "image/png", model: "img", tokensInput: 1, tokensOutput: 1 }),
          text: async () => "",
        };
      }
      if (String(url).endsWith("/internal/upload/base64")) {
        uploads++;
        return uploadOk("https://cdn.test/converted-data-uri.png");
      }
      throw new Error("unexpected url " + url);
    });

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.filled).toBe(4);
    expect(uploads).toBe(1); // only the existing data URI needed Cloudflare upload
  });

  it("legacy platform imageBase64 response is uploaded before storing", async () => {
    await seed();
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/internal/platform-images/generate")) return imageOk();
      if (String(url).endsWith("/internal/upload/base64")) return uploadOk();
      throw new Error("unexpected url " + url);
    });

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    const [row] = await db
      .select({ avatarUrl: audiences.avatarUrl })
      .from(audiences)
      .where(eq(audiences.id, NO_AV_A));
    expect(row.avatarUrl).toBe("https://cdn.test/audiences/avatar.png");
  });

  it("a per-row image failure is reported, others still fill", async () => {
    await seed();
    let call = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/internal/platform-images/generate")) {
        call++;
        if (call === 1) return { ok: false, status: 502, json: async () => ({}), text: async () => "gemini blip" };
        return imageOk();
      }
      if (String(url).endsWith("/internal/upload/base64")) return uploadOk();
      return imageOk();
    });

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.filled).toBe(3);
    expect(res.body.failed).toHaveLength(1);
  });

  it("async=true responds 202 immediately + fills in the background", async () => {
    await seed();
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/internal/platform-images/generate")) return imageOk();
      if (String(url).endsWith("/internal/upload/base64")) return uploadOk();
      throw new Error("unexpected url " + url);
    });

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false&async=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(202);
    expect(res.body.started).toBe(true);
    expect(res.body.scanned).toBe(4);

    let filled: Array<{ id: string }> = [];
    for (let i = 0; i < 50; i++) {
      filled = await db
        .select({ id: audiences.id })
        .from(audiences)
        .where(eq(audiences.avatarUrl, "https://cdn.test/audiences/avatar.png"));
      if (filled.length >= 4) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(filled.length).toBe(4);
  });

  it("requires api key", async () => {
    const res = await request(app).post("/internal/backfill-audience-avatars");
    expect(res.status).toBe(401);
  });
});
