import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000a1";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}
function err(status: number, text: string) {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

beforeEach(() => {
  fetchSpy.mockReset();
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.APIFY_SERVICE_URL = "http://apify:8080";
  process.env.APIFY_SERVICE_API_KEY = "apify-key";
});

afterAll(async () => {
  await closeDb();
});

// Route fetch by URL. `chat` is (provider, callIndexForProvider) => candidates[].
// `apolloCount`/`apifyCount` are (callIndex) => number | "400" (invalid filters).
function wire(opts: {
  chat: (provider: "apollo" | "apify", call: number) => unknown[];
  apolloCount?: (call: number) => number | "400";
  apifyCount?: (call: number) => number | "400";
}) {
  const chatCalls = { apollo: 0, apify: 0 };
  const dryCalls = { apollo: 0, apify: 0 };
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/search/filters-prompt"))
      return ok({ prompt: "RULES", schemaVersion: "1" });
    if (u.endsWith("/complete")) {
      const body = JSON.parse(init.body ?? "{}") as { systemPrompt: string };
      const provider = body.systemPrompt.includes("apify") ? "apify" : "apollo";
      const candidates = opts.chat(provider, chatCalls[provider]++);
      return ok({
        json: { candidates },
        content: "",
        tokensInput: 1,
        tokensOutput: 1,
        model: "claude-sonnet-4-6",
      });
    }
    if (u.endsWith("/search/dry-run")) {
      const v = (opts.apolloCount ?? (() => 100))(dryCalls.apollo++);
      return v === "400" ? err(400, "invalid filter") : ok({ totalEntries: v });
    }
    if (u.endsWith("/search/count")) {
      const v = (opts.apifyCount ?? (() => 50))(dryCalls.apify++);
      return v === "400" ? err(400, "invalid filter") : ok({ totalMatched: v });
    }
    throw new Error("unexpected url " + u);
  });
}

function suggest(nlPrompt: string) {
  return request(app)
    .post("/orgs/audiences/suggest")
    .set(getAuthHeaders())
    .send({ nlPrompt, brandId: BRAND });
}

describe("POST /orgs/audiences/suggest", () => {
  it("returns candidates from BOTH providers with live counts", async () => {
    wire({
      chat: (p) => [
        { label: `${p} CMOs`, rationale: "r", filters: { seniorities: ["c_suite"] } },
      ],
      apolloCount: () => 120,
      apifyCount: () => 45,
    });
    const res = await suggest("CMOs in fintech");
    expect(res.status).toBe(200);
    const byProvider = Object.fromEntries(
      res.body.candidates.map((c: { provider: string; count: number }) => [
        c.provider,
        c.count,
      ])
    );
    expect(byProvider.apollo).toBe(120);
    expect(byProvider.apify).toBe(45);
  });

  it("granularity emerges from the NL — N candidates per provider", async () => {
    wire({
      chat: (p) => [
        { label: `${p} France`, rationale: "r", filters: { locationCountries: ["France"] } },
        { label: `${p} Germany`, rationale: "r", filters: { locationCountries: ["Germany"] } },
      ],
      apolloCount: () => 30,
      apifyCount: () => 20,
    });
    const res = await suggest("founders in France and Germany separately");
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(4); // 2 per provider
    expect(
      res.body.candidates.filter((c: { provider: string }) => c.provider === "apollo")
    ).toHaveLength(2);
  });

  it("retries when a candidate returns zero, until non-zero (bounded)", async () => {
    // first chat call → narrow filters; dry-run 0; revise chat → broad; dry-run >0
    wire({
      chat: (p, call) =>
        call === 0
          ? [{ label: `${p} A`, rationale: "narrow", filters: { titles: ["X"] } }]
          : [{ label: `${p} A`, rationale: "broad", filters: { titles: ["Y"] } }],
      apolloCount: (call) => (call === 0 ? 0 : 500),
      apifyCount: (call) => (call === 0 ? 0 : 300),
    });
    const res = await suggest("hard audience");
    expect(res.status).toBe(200);
    const apollo = res.body.candidates.find(
      (c: { provider: string }) => c.provider === "apollo"
    );
    expect(apollo.count).toBe(500);
    expect(apollo.rationale).toBe("broad"); // the revised candidate
  });

  it("feeds provider validation errors (4xx) back to the LLM to revise", async () => {
    wire({
      chat: (p, call) =>
        call === 0
          ? [{ label: `${p} A`, rationale: "bad", filters: { seniorities: ["nope"] } }]
          : [{ label: `${p} A`, rationale: "fixed", filters: { seniorities: ["vp"] } }],
      apolloCount: (call) => (call === 0 ? "400" : 200),
      apifyCount: (call) => (call === 0 ? "400" : 80),
    });
    const res = await suggest("vps");
    expect(res.status).toBe(200);
    const apollo = res.body.candidates.find(
      (c: { provider: string }) => c.provider === "apollo"
    );
    expect(apollo.count).toBe(200);
    expect(apollo.validationError).toBeNull();
    expect(apollo.rationale).toBe("fixed");
  });

  it("surfaces count:0 honestly after the retry budget (no infinite loop)", async () => {
    wire({
      chat: (p) => [{ label: `${p} dry`, rationale: "r", filters: { titles: ["Z"] } }],
      apolloCount: () => 0, // never recovers
      apifyCount: () => 0,
    });
    const res = await suggest("impossible audience");
    expect(res.status).toBe(200);
    expect(res.body.candidates.every((c: { count: number }) => c.count === 0)).toBe(true);
  });

  it("caps candidates per provider and flags truncated", async () => {
    wire({
      chat: (p) =>
        Array.from({ length: 9 }, (_, i) => ({
          label: `${p} ${i}`,
          rationale: "r",
          filters: { locationCountries: [`C${i}`] },
        })),
      apolloCount: () => 10,
      apifyCount: () => 10,
    });
    const res = await suggest("every country");
    expect(res.status).toBe(200);
    const apollo = res.body.candidates.filter(
      (c: { provider: string }) => c.provider === "apollo"
    );
    expect(apollo.length).toBe(6); // capped
    expect(apollo.every((c: { truncated: boolean }) => c.truncated)).toBe(true);
  });

  it("502 when chat-service env is not configured", async () => {
    delete process.env.CHAT_SERVICE_URL;
    wire({ chat: (p) => [{ label: p, rationale: "r", filters: {} }] });
    const res = await suggest("anyone");
    expect(res.status).toBe(502);
  });

  it("400 when nlPrompt is missing", async () => {
    const res = await request(app)
      .post("/orgs/audiences/suggest")
      .set(getAuthHeaders())
      .send({ brandId: BRAND });
    expect(res.status).toBe(400);
  });

  it("persists a selected candidate's provider via POST /orgs/audiences", async () => {
    await cleanTestData();
    const res = await request(app)
      .post("/orgs/audiences")
      .set(getAuthHeaders())
      .send({
        name: "apollo CMOs",
        brandId: BRAND,
        provider: "apollo",
        filters: { seniorities: ["c_suite"] },
        apolloCount: 120,
      });
    expect(res.status).toBe(201);
    expect(res.body.audience.provider).toBe("apollo");
    expect(res.body.audience.apolloCount).toBe(120);
  });
});
