import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  platformCompleteJson,
  platformGenerateImage,
  PLATFORM_SUPPORT_KINDS,
} from "../../src/lib/chat-client.js";
import {
  generateAudienceDescription,
  DESCRIPTION_BACKFILL_SUPPORT,
  AVATAR_BACKFILL_SUPPORT,
} from "../../src/services/audiences.js";
import {
  draftSegmentTargetOnPlatform,
  TARGET_TEXT_BACKFILL_SUPPORT,
} from "../../src/services/audience-target.js";

/**
 * PLATFORM-CALLER-RUN-1024: every call to a chat-service /internal/platform-*
 * route states whose work it is, the caller's OWN run (x-run-id) or ONE
 * declared support function (body `support`), never both, never neither.
 * This file pins the mechanism and each call site's choice.
 */

const fetchBefore = globalThis.fetch;
const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

beforeEach(() => {
  process.env.CHAT_SERVICE_URL = "http://chat:3020";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    calls.push({ url: String(url), headers: init.headers ?? {}, body: JSON.parse(init.body ?? "{}") });
    if (String(url).endsWith("/internal/platform-images/generate")) {
      return ok({ url: "https://cdn.test/a.png", mimeType: "image/png", model: "m", tokensInput: 1, tokensOutput: 1 });
    }
    return ok({ json: { description: "Targets owners.", target: "Owners of clinics." } });
  });
});

afterAll(() => {
  globalThis.fetch = fetchBefore;
});

function headerKeys(h: Record<string, string>) {
  return Object.keys(h).map((k) => k.toLowerCase());
}

describe("platform caller mechanism", () => {
  it("a run caller sends x-run-id and no support", async () => {
    await platformCompleteJson({ message: "m", systemPrompt: "s", caller: { runId: "11111111-1111-4111-8111-111111111111" } });
    expect(calls[0].headers["x-run-id"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(calls[0].body.support).toBeUndefined();
  });

  it("a support caller sends support in the body and no x-run-id", async () => {
    const support = { kind: "product_feature" as const, reason: "r" };
    await platformCompleteJson({ message: "m", systemPrompt: "s", caller: { support } });
    await platformGenerateImage({ prompt: "p", caller: { support } });
    for (const c of calls) {
      expect(headerKeys(c.headers)).not.toContain("x-run-id");
      expect(c.body.support).toEqual(support);
    }
  });
});

describe("each call site's choice", () => {
  it("description backfill = support product_feature", async () => {
    await generateAudienceDescription({ name: "Agency Owners", filters: {} });
    expect(calls[0].url).toBe("http://chat:3020/internal/platform-complete");
    expect(headerKeys(calls[0].headers)).not.toContain("x-run-id");
    expect(calls[0].body.support).toEqual(DESCRIPTION_BACKFILL_SUPPORT);
    expect(DESCRIPTION_BACKFILL_SUPPORT.kind).toBe("product_feature");
  });

  it("target-text backfill = support product_feature", async () => {
    await draftSegmentTargetOnPlatform({
      sharedTarget: "Chiropractors",
      segment: { name: "Owners", description: "Clinic owners" },
      offers: [],
    }).catch(() => undefined);
    expect(calls[0].url).toBe("http://chat:3020/internal/platform-complete");
    expect(headerKeys(calls[0].headers)).not.toContain("x-run-id");
    expect(calls[0].body.support).toEqual(TARGET_TEXT_BACKFILL_SUPPORT);
    expect(TARGET_TEXT_BACKFILL_SUPPORT.kind).toBe("product_feature");
  });

  it("avatar backfill = support product_feature (call asserted in backfill-audience-avatars.test.ts)", () => {
    expect(AVATAR_BACKFILL_SUPPORT.kind).toBe("product_feature");
  });

  it("every declared kind is one chat-service accepts, with a reason", () => {
    for (const s of [DESCRIPTION_BACKFILL_SUPPORT, AVATAR_BACKFILL_SUPPORT, TARGET_TEXT_BACKFILL_SUPPORT]) {
      expect(PLATFORM_SUPPORT_KINDS).toContain(s.kind);
      expect(s.reason.length).toBeGreaterThan(0);
    }
  });
});
