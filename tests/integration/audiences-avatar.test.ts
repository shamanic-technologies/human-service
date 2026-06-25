import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000c1";

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
  await closeDb();
});

async function createAudience(name: string) {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({ name, brandId: BRAND, provider: "apollo", nlPrompt: "fintech CMOs", filters: { titles: ["CMO"] } });
  expect(res.status).toBe(201);
  return res.body.audience.id as string;
}

function avatar(id: string, body?: unknown) {
  return request(app).post(`/orgs/audiences/${id}/avatar`).set(getAuthHeaders()).send(body ?? {});
}

describe("POST /orgs/audiences/:id/avatar", () => {
  it("generates an avatar via chat-service and persists the returned hosted URL", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/orgs/images/generate"))
        return ok({ url: "https://cdn.test/audiences/cmos.png", mimeType: "image/png", model: "gemini-3.1-flash-image", tokensInput: 10, tokensOutput: 20 });
      throw new Error("unexpected url " + url);
    });
    const id = await createAudience("CMOs");
    const res = await avatar(id);
    expect(res.status).toBe(200);
    expect(res.body.audience.avatarUrl).toBe("https://cdn.test/audiences/cmos.png");
  });

  it("the audience GET reflects the persisted avatarUrl", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/orgs/images/generate"))
        return ok({ url: "https://cdn.test/audiences/get.png", mimeType: "image/png", model: "m", tokensInput: 1, tokensOutput: 1 });
      throw new Error("unexpected url " + url);
    });
    const id = await createAudience("CMOs Get");
    await avatar(id);
    const got = await request(app).get(`/orgs/audiences/${id}`).set(getAuthHeaders());
    expect(got.body.audience.avatarUrl).toBe("https://cdn.test/audiences/get.png");
  });

  it("regenerate overwrites the existing avatarUrl", async () => {
    let call = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/orgs/images/generate")) {
        call++;
        return ok({ url: `https://cdn.test/audiences/${call}.png`, mimeType: "image/png", model: "m", tokensInput: 1, tokensOutput: 1 });
      }
      throw new Error("unexpected url " + url);
    });
    const id = await createAudience("CMOs Regen");
    const first = await avatar(id);
    expect(first.body.audience.avatarUrl).toBe("https://cdn.test/audiences/1.png");
    const second = await avatar(id);
    expect(second.body.audience.avatarUrl).toBe("https://cdn.test/audiences/2.png");
  });

  it("502 when chat-service returns imageBase64 without a hosted URL", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/orgs/images/generate")) {
        return ok({ imageBase64: "AAAA", mimeType: "image/png", model: "m", tokensInput: 1, tokensOutput: 1 });
      }
      throw new Error("unexpected url " + url);
    });

    const id = await createAudience("CMOs Legacy");
    const res = await avatar(id);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("no hosted image URL");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards an optional prompt override to chat-service", async () => {
    let sentPrompt: string | undefined;
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      if (String(url).endsWith("/orgs/images/generate")) {
        sentPrompt = (JSON.parse(init.body ?? "{}") as { prompt?: string }).prompt;
        return ok({ url: "https://cdn.test/audiences/prompt.png", mimeType: "image/png", model: "m", tokensInput: 1, tokensOutput: 1 });
      }
      throw new Error("unexpected url " + url);
    });
    const id = await createAudience("CMOs Override");
    const res = await avatar(id, { prompt: "a custom robot mascot" });
    expect(res.status).toBe(200);
    expect(sentPrompt).toBe("a custom robot mascot");
  });

  it("404 for an unknown audience id", async () => {
    const res = await avatar("00000000-0000-4000-8000-0000000000fe");
    expect(res.status).toBe(404);
  });

  it("502 when chat-service env is not configured", async () => {
    delete process.env.CHAT_SERVICE_URL;
    const id = await createAudience("CMOs NoEnv");
    const res = await avatar(id);
    expect(res.status).toBe(502);
  });
});
