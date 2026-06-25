import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const app = createTestApp();
const ORG = "00000000-0000-0000-0000-000000000001";
const BRAND = "00000000-0000-4000-8000-0000000000d1";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
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

async function seedAudience(
  overrides: Partial<typeof audiences.$inferInsert> = {}
) {
  const [row] = await db
    .insert(audiences)
    .values({
      orgId: ORG,
      brandId: BRAND,
      name: `aud-${Math.random().toString(36).slice(2)}`,
      provider: "apollo",
      filters: { titles: ["CEO"] },
      status: "paused",
      ...overrides,
    })
    .returning();
  return row;
}

function patchStatus(id: string, status: string) {
  return request(app)
    .patch(`/orgs/audiences/${id}/status`)
    .set(getAuthHeaders())
    .send({ status });
}

// Poll until the predicate holds or the timeout elapses (the avatar generation
// is fire-and-forget, so it completes AFTER the status response returns).
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

async function avatarUrlOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ avatarUrl: audiences.avatarUrl })
    .from(audiences)
    .where(eq(audiences.id, id));
  return row?.avatarUrl ?? null;
}

describe("auto-generate audience avatar on activation", () => {
  it("AC1: PATCH status→active with no avatarUrl generates + persists the avatar in the background (org-billed)", async () => {
    fetchSpy.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (String(url).endsWith("/orgs/images/generate")) {
        // org-billed: chat-service resolves the key from the inbound identity
        // headers (the same x-org-id/x-user-id the status request carried).
        expect(init?.headers?.["x-org-id"]).toBe(ORG);
        return ok({ url: "https://cdn.test/audiences/auto.png", mimeType: "image/png", model: "m", tokensInput: 1, tokensOutput: 1 });
      }
      throw new Error("unexpected url " + url);
    });

    const aud = await seedAudience({ status: "paused", avatarUrl: null });
    const res = await patchStatus(aud.id, "active");

    // status flip responds immediately, before the avatar exists
    expect(res.status).toBe(200);
    expect(res.body.audience.status).toBe("active");

    const generated = await waitFor(async () => (await avatarUrlOf(aud.id)) !== null);
    expect(generated).toBe(true);
    expect(await avatarUrlOf(aud.id)).toBe("https://cdn.test/audiences/auto.png");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("AC2: PATCH status→active on an audience that already has an avatarUrl does NOT regenerate", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      throw new Error("chat-service must not be called: " + url);
    });

    const aud = await seedAudience({
      status: "paused",
      avatarUrl: "https://cdn.test/audiences/existing.png",
    });
    const res = await patchStatus(aud.id, "active");

    expect(res.status).toBe(200);
    // give any (erroneous) background fire a chance to run, then assert it didn't
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await avatarUrlOf(aud.id)).toBe("https://cdn.test/audiences/existing.png");
  });

  it("AC3: PATCH status→paused / archived never generates an avatar", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      throw new Error("chat-service must not be called: " + url);
    });

    const a1 = await seedAudience({ status: "active", avatarUrl: null });
    const r1 = await patchStatus(a1.id, "paused");
    expect(r1.status).toBe(200);

    const a2 = await seedAudience({ status: "active", avatarUrl: null });
    const r2 = await patchStatus(a2.id, "archived");
    expect(r2.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await avatarUrlOf(a1.id)).toBeNull();
    expect(await avatarUrlOf(a2.id)).toBeNull();
  });

  it("AC4: avatar generation failure (chat-service error) does not affect the status flip", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/orgs/images/generate")) {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }), text: async () => "boom" };
      }
      throw new Error("unexpected url " + url);
    });

    const aud = await seedAudience({ status: "paused", avatarUrl: null });
    const res = await patchStatus(aud.id, "active");

    // status flip succeeds regardless of avatar outcome
    expect(res.status).toBe(200);
    expect(res.body.audience.status).toBe("active");

    // chat-service WAS attempted, but persisted avatar stays null (failure logged)
    const attempted = await waitFor(async () => fetchSpy.mock.calls.length > 0);
    expect(attempted).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(await avatarUrlOf(aud.id)).toBeNull();
  });
});
