import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { judgeYesNo, ChatServiceError } from "../../src/lib/chat-client.js";

// A Jev answer without a yes-probability is an ERROR, never a pass or a
// default: the pre-pay screen decides whether an apollo credit is spent on it.

const fetchBefore = globalThis.fetch;
const fetchSpy = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
});

afterAll(() => {
  globalThis.fetch = fetchBefore;
});

function answer(body: unknown, status = 200) {
  fetchSpy.mockResolvedValueOnce({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

const identity = { orgId: "00000000-0000-4000-8000-000000000001", userId: "u1", runId: "r1" };

describe("judgeYesNo", () => {
  it("asks ONE noul question and returns its yes-probability + serving model", async () => {
    answer({ model: "jev-1.13.0", answers: { answer: { type: "noul", noul: 0.12 } } });
    const out = await judgeYesNo({ state: { a: 1 }, instructions: "Q?", identity });
    expect(out).toEqual({ yesProbability: 0.12, model: "jev-1.13.0" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://chat:8080/orgs/judgments");
    expect(JSON.parse(init.body)).toEqual({
      state: { a: 1 },
      questions: { answer: { type: "noul", instructions: "Q?" } },
    });
    expect(init.headers["x-org-id"]).toBe(identity.orgId);
    expect(init.headers["x-run-id"]).toBe("r1");
  });

  it.each([
    ["missing probability", { model: "jev", answers: { answer: { type: "noul" } } }],
    ["probability out of range", { model: "jev", answers: { answer: { type: "noul", noul: 1.2 } } }],
    ["no answer", { model: "jev", answers: {} }],
    ["no model", { answers: { answer: { type: "noul", noul: 0.9 } } }],
  ])("throws on %s", async (_label, body) => {
    answer(body);
    await expect(judgeYesNo({ state: "s", instructions: "Q?", identity })).rejects.toBeInstanceOf(
      ChatServiceError
    );
  });

  it("propagates a chat-service error status", async () => {
    answer({ error: "down" }, 503);
    await expect(judgeYesNo({ state: "s", instructions: "Q?", identity })).rejects.toMatchObject({
      status: 503,
    });
  });
});
