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
const HAS_AV = "c0000000-0000-4000-8000-000000000003";
const NO_USER = "c0000000-0000-4000-8000-000000000004";
const DEPRECATED = "c0000000-0000-4000-8000-000000000005";

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

async function seed() {
  await db.insert(audiences).values([
    { id: NO_AV_A, orgId: ORG, brandId: BRAND, name: "No Avatar A", status: "active", createdByUserId: USER },
    { id: NO_AV_B, orgId: ORG, brandId: BRAND, name: "No Avatar B", status: "suggested", createdByUserId: USER },
    { id: HAS_AV, orgId: ORG, brandId: BRAND, name: "Has Avatar", status: "active", createdByUserId: USER, avatarUrl: "data:image/png;base64,XXXX" },
    { id: NO_USER, orgId: ORG, brandId: BRAND, name: "No User", status: "active", createdByUserId: null },
    { id: DEPRECATED, orgId: ORG, brandId: BRAND, name: "Deprecated", status: "deprecated", createdByUserId: USER },
  ]);
}

beforeEach(async () => {
  fetchSpy.mockReset();
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /internal/backfill-audience-avatars", () => {
  it("dry-run counts ALL live avatar-less rows (incl. no-user), calls nothing", async () => {
    await seed();
    fetchSpy.mockImplementation(async () => imageOk());

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.scanned).toBe(3); // NO_AV_A + NO_AV_B + NO_USER (HAS_AV/DEPRECATED excluded)
    expect(res.body.skippedNoUser).toBeUndefined();
    expect(res.body.wouldFill).toBe(3);
    expect(res.body.filled).toBe(0);
    expect(res.body.sample).toHaveLength(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("real run fills avatars (incl. no-user rows via platform path); re-run is idempotent", async () => {
    await seed();
    fetchSpy.mockImplementation(async () => imageOk());

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.filled).toBe(3);
    expect(res.body.failed).toEqual([]);

    const [a] = await db
      .select({ avatarUrl: audiences.avatarUrl })
      .from(audiences)
      .where(eq(audiences.id, NO_AV_A));
    expect(a.avatarUrl).toBe("data:image/png;base64,AAAA");

    // Pre-existing avatar untouched.
    const [h] = await db
      .select({ avatarUrl: audiences.avatarUrl })
      .from(audiences)
      .where(eq(audiences.id, HAS_AV));
    expect(h.avatarUrl).toBe("data:image/png;base64,XXXX");

    // NO_USER IS filled now (platform path needs no user).
    const [n] = await db
      .select({ avatarUrl: audiences.avatarUrl })
      .from(audiences)
      .where(eq(audiences.id, NO_USER));
    expect(n.avatarUrl).toBe("data:image/png;base64,AAAA");

    // Re-run: no avatar-less live rows left.
    const reRun = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false")
      .set(apiKeyHeader);
    expect(reRun.body.scanned).toBe(0);
    expect(reRun.body.filled).toBe(0);
  });

  it("a per-row image failure is reported, others still fill", async () => {
    await seed();
    let call = 0;
    fetchSpy.mockImplementation(async () => {
      call++;
      if (call === 1) return { ok: false, status: 502, json: async () => ({}), text: async () => "gemini blip" };
      return imageOk();
    });

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.filled).toBe(2);
    expect(res.body.failed).toHaveLength(1);
  });

  it("async=true responds 202 immediately + fills in the background", async () => {
    await seed();
    fetchSpy.mockImplementation(async () => imageOk());

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false&async=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(202);
    expect(res.body.started).toBe(true);
    expect(res.body.scanned).toBe(3);

    let filled: Array<{ id: string }> = [];
    for (let i = 0; i < 50; i++) {
      filled = await db
        .select({ id: audiences.id })
        .from(audiences)
        .where(eq(audiences.avatarUrl, "data:image/png;base64,AAAA"));
      if (filled.length >= 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(filled.length).toBe(3);
  });

  it("requires api key", async () => {
    const res = await request(app).post("/internal/backfill-audience-avatars");
    expect(res.status).toBe(401);
  });
});
