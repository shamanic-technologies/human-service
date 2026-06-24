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
  it("dry-run counts live avatar-less rows + reports skippedNoUser, calls nothing", async () => {
    await seed();
    fetchSpy.mockImplementation(async () => imageOk());

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.scanned).toBe(2); // NO_AV_A + NO_AV_B (HAS_AV/DEPRECATED/NO_USER excluded)
    expect(res.body.skippedNoUser).toBe(1); // NO_USER
    expect(res.body.wouldFill).toBe(2);
    expect(res.body.filled).toBe(0);
    expect(res.body.sample).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("real run fills avatars for live avatar-less rows; re-run is idempotent", async () => {
    await seed();
    fetchSpy.mockImplementation(async () => imageOk());

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.filled).toBe(2);
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

    // NO_USER never generated.
    const [n] = await db
      .select({ avatarUrl: audiences.avatarUrl })
      .from(audiences)
      .where(eq(audiences.id, NO_USER));
    expect(n.avatarUrl).toBeNull();

    // Re-run: no avatar-less rows with a user left.
    const reRun = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false")
      .set(apiKeyHeader);
    expect(reRun.body.scanned).toBe(0);
    expect(reRun.body.filled).toBe(0);
  });

  it("a per-row image failure (e.g. zero-balance org 402) is reported, others still fill", async () => {
    await seed();
    let call = 0;
    fetchSpy.mockImplementation(async () => {
      call++;
      if (call === 1) return { ok: false, status: 402, json: async () => ({}), text: async () => "insufficient balance" };
      return imageOk();
    });

    const res = await request(app)
      .post("/internal/backfill-audience-avatars?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.filled).toBe(1);
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
    expect(res.body.scanned).toBe(2);

    let filled: Array<{ id: string }> = [];
    for (let i = 0; i < 50; i++) {
      filled = await db
        .select({ id: audiences.id })
        .from(audiences)
        .where(eq(audiences.avatarUrl, "data:image/png;base64,AAAA"));
      if (filled.length >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(filled.length).toBe(2);
  });

  it("requires api key", async () => {
    const res = await request(app).post("/internal/backfill-audience-avatars");
    expect(res.status).toBe(401);
  });
});
