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

beforeEach(async () => {
  fetchSpy.mockReset();
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.APIFY_SERVICE_URL = "http://apify:8080";
  process.env.APIFY_SERVICE_API_KEY = "apify-key";
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

type Action = Record<string, unknown>;

// Mock the chat-service + provider fleet by URL.
// - /complete LAYER 1 (systemPrompt mentions "decompose"): returns the segments.
// - /complete LAYER 2 (systemPrompt mentions "build a <provider>"): a multi-turn
//   agentic loop. `act(provider, cleanTests)` decides the next action; default is
//   "test until one clean count, then confirm". `cleanTests` = number of prior
//   non-rejected tests, derived from "-> count=" markers in the transcript.
// - /search/dry-run (apollo) and /search/count (apify) return the dry-run counts.
function wire(opts: {
  segments: Array<{ name: string; description: string }>;
  act?: (provider: "apollo" | "apify", cleanTests: number, msg: string) => Action;
  apolloCount?: (call: number) => number | "400";
  apifyCount?: (call: number) => number | "400";
}) {
  const dryCalls = { apollo: 0, apify: 0 };
  const defaultAct = (_p: string, cleanTests: number): Action =>
    cleanTests === 0
      ? { action: "test", filters: { titles: ["X"] }, reasoning: "r" }
      : { action: "confirm", reasoning: "r" };

  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/search/filters-prompt"))
      return ok({ prompt: "RULES", schemaVersion: "1" });
    if (u.endsWith("/reference/industries"))
      return ok({ industries: [{ name: "Computer Software" }, { name: "Banking" }] });
    if (u.endsWith("/complete")) {
      const body = JSON.parse(init.body ?? "{}") as {
        systemPrompt: string;
        message: string;
      };
      if (body.systemPrompt.includes("decompose a natural-language audience")) {
        return ok({
          json: { audiences: opts.segments },
          content: "",
          tokensInput: 1,
          tokensOutput: 1,
          model: "gemini-flash",
        });
      }
      const provider = body.systemPrompt.includes("build a apify")
        ? "apify"
        : "apollo";
      const cleanTests = (body.message.match(/-> count=/g) ?? []).length;
      const action = (opts.act ?? defaultAct)(provider, cleanTests, body.message);
      return ok({
        json: action,
        content: "",
        tokensInput: 1,
        tokensOutput: 1,
        model: "gemini-flash",
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
  it("layer 1 decomposes into N named audiences; one candidate per audience", async () => {
    wire({
      segments: [
        { name: "US companies", description: "companies in the US" },
        { name: "Europe companies", description: "companies in Europe" },
      ],
    });
    const res = await suggest("companies in US and Europe separately");
    expect(res.status).toBe(200);
    // ONE candidate per layer-1 audience (NOT one per provider).
    expect(res.body.candidates).toHaveLength(2);
    const names = res.body.candidates.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(["Europe companies", "US companies"]);
    for (const c of res.body.candidates) {
      expect(c.audienceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.status).toBe("suggested");
      expect(["apollo", "apify"]).toContain(c.provider);
    }
  });

  it("collapses to the provider with the larger count", async () => {
    wire({
      segments: [{ name: "CMOs", description: "CMOs in fintech" }],
      apolloCount: () => 120,
      apifyCount: () => 45,
    });
    const res = await suggest("CMOs in fintech");
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0].provider).toBe("apollo");
    expect(res.body.candidates[0].count).toBe(120);
  });

  it("resolves a count tie to apollo", async () => {
    wire({
      segments: [{ name: "VPs", description: "VPs of eng" }],
      apolloCount: () => 50,
      apifyCount: () => 50,
    });
    const res = await suggest("VPs of engineering");
    expect(res.status).toBe(200);
    expect(res.body.candidates[0].provider).toBe("apollo");
    expect(res.body.candidates[0].count).toBe(50);
  });

  it("lets layer-2 iterate (test again) when not satisfied with the count, before confirming", async () => {
    let apolloDryRuns = 0;
    wire({
      segments: [{ name: "Founders", description: "startup founders" }],
      // test twice (narrow then broad), then confirm
      act: (_p, cleanTests) =>
        cleanTests < 2
          ? { action: "test", filters: { titles: [`T${cleanTests}`] }, reasoning: "r" }
          : { action: "confirm", reasoning: "r" },
      apolloCount: (call) => {
        apolloDryRuns = Math.max(apolloDryRuns, call + 1);
        return call === 0 ? 50 : 500; // first attempt too few, second healthy
      },
      apifyCount: () => 10,
    });
    const res = await suggest("startup founders");
    expect(res.status).toBe(200);
    const c = res.body.candidates[0];
    expect(c.provider).toBe("apollo"); // 500 > apify's 10
    expect(c.count).toBe(500); // the confirmed (second) test's count
    expect(apolloDryRuns).toBeGreaterThanOrEqual(2); // it iterated, not one-shot
  });

  it("feeds a provider 4xx back to layer-2 to revise, then confirms the valid set", async () => {
    wire({
      segments: [{ name: "Seniors", description: "senior ICs" }],
      apolloCount: (call) => (call === 0 ? "400" : 200), // first invalid, then valid
      apifyCount: () => 30,
    });
    const res = await suggest("senior individual contributors");
    expect(res.status).toBe(200);
    const c = res.body.candidates[0];
    expect(c.provider).toBe("apollo");
    expect(c.count).toBe(200);
    expect(c.validationError).toBeNull();
  });

  it("feeds a malformed LLM filter shape back to layer-2 (no crash), then confirms the valid set", async () => {
    // The LLM returns `keywords` as a STRING instead of string[] on its first
    // test. Pre-fix this crashed in toApolloSearchParams (`.join is not a
    // function`) -> uncaught -> 500. It must instead surface as a validation
    // error fed back into the loop, exactly like a provider 4xx.
    wire({
      segments: [{ name: "Founders", description: "startup founders" }],
      act: (_p, _cleanTests, msg) => {
        if (msg.includes("-> count=")) return { action: "confirm", reasoning: "r" };
        if (msg.includes("Invalid filter shape"))
          return { action: "test", filters: { titles: ["Founder"] }, reasoning: "r" };
        // malformed: keywords must be string[], not a string
        return { action: "test", filters: { keywords: "founders" }, reasoning: "r" };
      },
      apolloCount: () => 200,
      apifyCount: () => 30,
    });
    const res = await suggest("startup founders");
    expect(res.status).toBe(200);
    const c = res.body.candidates[0];
    expect(c.provider).toBe("apollo");
    expect(c.count).toBe(200);
    expect(c.validationError).toBeNull();
  });

  it("does not inject rule-based filters from the original prompt after layer-1 split", async () => {
    const dryRunBodies: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/search/filters-prompt"))
        return ok({ prompt: "RULES", schemaVersion: "1" });
      if (u.endsWith("/reference/industries"))
        return ok({
          industries: [
            { name: "Computer Software" },
            { name: "Professional Services" },
          ],
        });
      if (u.endsWith("/complete")) {
        const body = JSON.parse(init.body ?? "{}") as {
          systemPrompt: string;
          message: string;
        };
        if (body.systemPrompt.includes("decompose a natural-language audience")) {
          return ok({
            json: {
              audiences: [
                {
                  name: "B2B SaaS Leaders",
                  description:
                    "Founders and Heads of Growth at bootstrapped B2B SaaS companies with 1-50 employees.",
                },
              ],
            },
          });
        }
        const cleanTests = (body.message.match(/-> count=/g) ?? []).length;
        return ok({
          json:
            cleanTests === 0
              ? {
                  action: "test",
                  filters: { titles: ["Founder", "Head of Growth"] },
                  reasoning: "title-only draft",
                }
              : { action: "confirm", reasoning: "confirmed" },
        });
      }
      if (u.endsWith("/search/dry-run")) {
        dryRunBodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
        return ok({ totalEntries: 12500 });
      }
      throw new Error("unexpected url " + u);
    });

    const res = await suggest(
      "Founders and Heads of Growth at bootstrapped B2B SaaS companies with 1-50 employees and $1M-$10M/yr revenue."
    );

    expect(res.status).toBe(200);
    const c = res.body.candidates[0];
    expect(c.filters).toEqual({ titles: ["Founder", "Head of Growth"] });

    const lastDryRun = dryRunBodies.at(-1);
    expect(lastDryRun).toEqual({
      personTitles: ["Founder", "Head of Growth"],
    });
  });

  it("carries explicit firmographic constraints when layer-2 proposes them", async () => {
    const dryRunBodies: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/search/filters-prompt"))
        return ok({ prompt: "RULES", schemaVersion: "1" });
      if (u.endsWith("/reference/industries"))
        return ok({
          industries: [
            { name: "Computer Software" },
            { name: "Professional Services" },
            { name: "Banking" },
          ],
        });
      if (u.endsWith("/complete")) {
        const body = JSON.parse(init.body ?? "{}") as {
          systemPrompt: string;
          message: string;
        };
        if (body.systemPrompt.includes("decompose a natural-language audience")) {
          return ok({
            json: {
              audiences: [
                {
                  name: "Sales B2B SMB",
                  description:
                    "Heads of Sales, VP of Sales, or Founders at B2B professional services and software companies with 10-100 employees and $1M-$10M annual revenue.",
                },
              ],
            },
          });
        }
        const cleanTests = (body.message.match(/-> count=/g) ?? []).length;
        return ok({
          json:
            cleanTests === 0
              ? {
                  action: "test",
                  filters: {
                    titles: ["Head of Sales", "VP of Sales", "Founder"],
                    employeeMin: 10,
                    employeeMax: 100,
                    revenueRanges: ["1000000,10000000"],
                    industries: ["Computer Software", "Professional Services"],
                    keywords: ["B2B", "basic CRM tools", "spreadsheets"],
                  },
                  reasoning: "self-contained segment filters",
                }
              : { action: "confirm", reasoning: "confirmed" },
        });
      }
      if (u.endsWith("/search/dry-run")) {
        dryRunBodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
        return ok({ totalEntries: 12500 });
      }
      throw new Error("unexpected url " + u);
    });

    const res = await suggest(
      "Heads of Sales, VP of Sales, or Founders at B2B professional services and software companies with 10-100 employees and $1M-$10M/yr revenue, who are currently using basic CRM tools or spreadsheets and are looking to consolidate outbound prospecting, email sequencing, and contact database into a single affordable platform."
    );

    expect(res.status).toBe(200);
    const c = res.body.candidates[0];
    expect(c.provider).toBe("apollo");
    expect(c.filters).toMatchObject({
      titles: ["Head of Sales", "VP of Sales", "Founder"],
      employeeMin: 10,
      employeeMax: 100,
      revenueRanges: ["1000000,10000000"],
      industries: ["Computer Software", "Professional Services"],
    });
    expect(c.filters.keywords).toEqual(
      expect.arrayContaining(["B2B", "basic CRM tools", "spreadsheets"])
    );
    expect(c.rationale).toContain("10-100 employees");
    expect(c.rationale).toContain("$1M-$10M annual revenue");

    const lastDryRun = dryRunBodies.at(-1);
    expect(lastDryRun).toMatchObject({
      personTitles: ["Head of Sales", "VP of Sales", "Founder"],
      organizationNumEmployeesRanges: ["1,10", "11,20", "21,50", "51,100"],
      revenueRange: ["1000000,10000000"],
      qOrganizationIndustryTagIds: ["Computer Software", "Professional Services"],
    });

    const persisted = await request(app)
      .get(`/orgs/audiences/${c.audienceId}`)
      .set(getAuthHeaders());
    expect(persisted.status).toBe(200);
    expect(persisted.body.audience.filters).toMatchObject(c.filters);
  });

  it("surfaces count:0 honestly when neither provider yields matches", async () => {
    wire({
      segments: [{ name: "Impossible", description: "nobody" }],
      apolloCount: () => 0,
      apifyCount: () => 0,
    });
    const res = await suggest("impossible audience");
    expect(res.status).toBe(200);
    expect(res.body.candidates[0].count).toBe(0);
  });

  it("caps layer-1 audiences and flags truncated", async () => {
    wire({
      segments: Array.from({ length: 9 }, (_, i) => ({
        name: `Seg ${i}`,
        description: `segment ${i}`,
      })),
    });
    const res = await suggest("every country");
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(6); // capped
    expect(res.body.candidates.every((c: { truncated: boolean }) => c.truncated)).toBe(
      true
    );
  });

  it("persists candidates at status 'suggested' (inactive) and exposes them via GET ?status=suggested", async () => {
    wire({
      segments: [
        { name: "Alpha", description: "alpha" },
        { name: "Beta", description: "beta" },
      ],
    });
    const res = await suggest("alpha and beta");
    expect(res.status).toBe(200);
    const ids = res.body.candidates.map((c: { audienceId: string }) => c.audienceId);

    const suggested = await request(app)
      .get(`/orgs/audiences?brandId=${BRAND}&status=suggested`)
      .set(getAuthHeaders());
    expect(suggested.status).toBe(200);
    expect(suggested.body.audiences).toHaveLength(2);

    // None are active until the caller flips them.
    const active = await request(app)
      .get(`/orgs/audiences?brandId=${BRAND}&status=active`)
      .set(getAuthHeaders());
    expect(active.body.audiences).toHaveLength(0);

    // Activation via the existing status endpoint.
    const patched = await request(app)
      .patch(`/orgs/audiences/${ids[0]}/status`)
      .set(getAuthHeaders())
      .send({ status: "active" });
    expect(patched.status).toBe(200);
    expect(patched.body.audience.status).toBe("active");
  });

  it("re-running suggest refreshes a still-suggested row (no duplicate), never an active one", async () => {
    wire({
      segments: [{ name: "Repeat", description: "repeat audience" }],
      apolloCount: () => 11,
      apifyCount: () => 5,
    });
    const first = await suggest("repeat audience");
    const id = first.body.candidates[0].audienceId;

    const second = await suggest("repeat audience");
    expect(second.body.candidates[0].audienceId).toBe(id); // same row, refreshed

    const all = await request(app)
      .get(`/orgs/audiences?brandId=${BRAND}`)
      .set(getAuthHeaders());
    expect(all.body.audiences).toHaveLength(1); // no duplicate

    // Activate it, then re-run: the active row must NOT be mutated.
    await request(app)
      .patch(`/orgs/audiences/${id}/status`)
      .set(getAuthHeaders())
      .send({ status: "active" });
    const third = await suggest("repeat audience");
    expect(third.body.candidates[0].audienceId).toBe(id);
    const after = await request(app)
      .get(`/orgs/audiences/${id}`)
      .set(getAuthHeaders());
    expect(after.body.audience.status).toBe("active"); // untouched
  });

  it("calls chat-service with google JSON mode, a responseSchema, and disableThinking", async () => {
    const completeBodies: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/search/filters-prompt"))
        return ok({ prompt: "RULES", schemaVersion: "1" });
      if (u.endsWith("/reference/industries"))
        return ok({ industries: [{ name: "Computer Software" }] });
      if (u.endsWith("/complete")) {
        const body = JSON.parse(init.body ?? "{}");
        completeBodies.push(body);
        if (body.systemPrompt.includes("decompose a natural-language audience")) {
          return ok({ json: { audiences: [{ name: "CMOs", description: "cmos" }] } });
        }
        const cleanTests = (String(body.message).match(/-> count=/g) ?? []).length;
        return ok({
          json:
            cleanTests === 0
              ? { action: "test", filters: { seniorities: ["c_suite"] } }
              : { action: "confirm" },
        });
      }
      if (u.endsWith("/search/dry-run")) return ok({ totalEntries: 100 });
      if (u.endsWith("/search/count")) return ok({ totalMatched: 50 });
      throw new Error("unexpected url " + u);
    });
    const res = await suggest("CMOs");
    expect(res.status).toBe(200);
    expect(completeBodies.length).toBeGreaterThan(0);
    for (const body of completeBodies) {
      expect(body.provider).toBe("google");
      expect(body.model).toBe("flash-pro");
      expect(body.responseFormat).toBe("json");
      // Provider-enforced shape: every suggest call now ships a responseSchema
      // (layer-1 audiences object OR layer-2 action object) + disableThinking.
      expect(body.responseSchema).toBeDefined();
      expect((body.responseSchema as { type?: string }).type).toBe("object");
      expect(body.disableThinking).toBe(true);
    }
  });

  it("retries a transient chat-service 502 (malformed-JSON / blip) and still succeeds", async () => {
    // The FIRST layer-1 /complete returns a 502 (chat-service's response for a
    // non-parsable LLM output); the retry returns a clean parse. Pre-fix this
    // single 502 anywhere in the fan-out 502'd the whole request (~50% flake).
    let layer1Calls = 0;
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/search/filters-prompt"))
        return ok({ prompt: "RULES", schemaVersion: "1" });
      if (u.endsWith("/reference/industries"))
        return ok({ industries: [{ name: "Computer Software" }] });
      if (u.endsWith("/complete")) {
        const body = JSON.parse(init.body ?? "{}") as { systemPrompt: string; message: string };
        if (body.systemPrompt.includes("decompose a natural-language audience")) {
          layer1Calls++;
          if (layer1Calls === 1) return err(502, "model returned non-parsable JSON");
          return ok({ json: { audiences: [{ name: "CMOs", description: "cmos" }] } });
        }
        const cleanTests = (body.message.match(/-> count=/g) ?? []).length;
        return ok({
          json: cleanTests === 0 ? { action: "test", filters: { titles: ["CMO"] } } : { action: "confirm" },
        });
      }
      if (u.endsWith("/search/dry-run")) return ok({ totalEntries: 100 });
      if (u.endsWith("/search/count")) return ok({ totalMatched: 50 });
      throw new Error("unexpected url " + u);
    });
    const res = await suggest("CMOs");
    expect(res.status).toBe(200);
    expect(layer1Calls).toBe(2); // retried once
    expect(res.body.candidates).toHaveLength(1);
  });

  it("does NOT retry a chat-service 402 (insufficient credits) — fails fast", async () => {
    let layer1Calls = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/complete")) {
        layer1Calls++;
        return err(402, "Insufficient credits");
      }
      throw new Error("unexpected url " + u);
    });
    const res = await suggest("CMOs");
    expect(res.status).toBe(502); // surfaced as 502 to the front
    expect(layer1Calls).toBe(1); // NOT retried — deterministic 4xx
  });

  it("tolerates one segment failing on BOTH providers and still returns the others", async () => {
    // The "Bad" segment's layer-2 /complete 5xx's on BOTH providers (a real
    // chat-service outage that survives the retry budget); "Good" is fine. The
    // segment description is reliably present in the layer-2 transcript message,
    // so we key the outage on it. Pre-fix the Promise.all rejected the WHOLE
    // batch on one segment's failure; now Good still returns.
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/search/filters-prompt"))
        return ok({ prompt: "RULES", schemaVersion: "1" });
      if (u.endsWith("/reference/industries"))
        return ok({ industries: [{ name: "Computer Software" }] });
      if (u.endsWith("/complete")) {
        const body = JSON.parse(init.body ?? "{}") as { systemPrompt: string; message: string };
        if (body.systemPrompt.includes("decompose a natural-language audience")) {
          return ok({
            json: {
              audiences: [
                { name: "Good", description: "good seg" },
                { name: "Bad", description: "bad seg" },
              ],
            },
          });
        }
        // Persistent 5xx for the Bad segment's layer-2 (both providers) — even
        // the retry can't recover it, so the segment fails.
        if (body.message.includes("bad seg")) return err(503, "model overloaded");
        const cleanTests = (body.message.match(/-> count=/g) ?? []).length;
        return ok({
          json: cleanTests === 0 ? { action: "test", filters: { titles: ["X"] } } : { action: "confirm" },
        });
      }
      if (u.endsWith("/search/dry-run")) return ok({ totalEntries: 300 });
      if (u.endsWith("/search/count")) return ok({ totalMatched: 80 });
      throw new Error("unexpected url " + u);
    });
    const res = await suggest("good and bad");
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1); // Bad dropped, Good kept
    expect(res.body.candidates[0].name).toBe("Good");
  });

  it("injects apollo's canonical industries list into the apollo layer-2 prompt (apollo-only — apify is never queried)", async () => {
    const layer2: Array<{ provider: "apollo" | "apify"; systemPrompt: string }> = [];
    let referenceCalls = 0;
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/search/filters-prompt"))
        return ok({ prompt: "RULES", schemaVersion: "1" });
      if (u.endsWith("/reference/industries")) {
        referenceCalls++;
        return ok({ industries: [{ name: "Computer Software" }, { name: "Banking" }] });
      }
      if (u.endsWith("/complete")) {
        const body = JSON.parse(init.body ?? "{}") as {
          systemPrompt: string;
          message: string;
        };
        if (body.systemPrompt.includes("decompose a natural-language audience")) {
          return ok({ json: { audiences: [{ name: "Fintech CTOs", description: "CTOs in fintech" }] } });
        }
        const provider = body.systemPrompt.includes("build a apify") ? "apify" : "apollo";
        layer2.push({ provider, systemPrompt: body.systemPrompt });
        const cleanTests = (body.message.match(/-> count=/g) ?? []).length;
        return ok({
          json: cleanTests === 0
            ? { action: "test", filters: { titles: ["CTO"] } }
            : { action: "confirm" },
        });
      }
      if (u.endsWith("/search/dry-run")) return ok({ totalEntries: 800 });
      if (u.endsWith("/search/count")) return ok({ totalMatched: 40 });
      throw new Error("unexpected url " + u);
    });

    const res = await suggest("CTOs in fintech");
    expect(res.status).toBe(200);

    // apollo reference fetched (at least once); injected into the apollo prompt.
    expect(referenceCalls).toBeGreaterThanOrEqual(1);
    const apolloPrompt = layer2.find((l) => l.provider === "apollo")?.systemPrompt;
    const apifyPrompt = layer2.find((l) => l.provider === "apify")?.systemPrompt;
    expect(apolloPrompt).toContain("CANONICAL INDUSTRIES");
    expect(apolloPrompt).toContain("Computer Software");
    // APOLLO-ONLY: apify is no longer part of the suggest fan-out, so its
    // layer-2 prompt is never built.
    expect(apifyPrompt).toBeUndefined();
  });

  it("502 when chat-service env is not configured", async () => {
    delete process.env.CHAT_SERVICE_URL;
    wire({ segments: [{ name: "X", description: "x" }] });
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
});
