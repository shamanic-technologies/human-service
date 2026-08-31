import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";

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

interface ApolloResp {
  apolloAudienceId: string;
  filters: Record<string, unknown>;
  count: number;
  // apollo-service#228: additive on their side, so the default mock deliberately
  // OMITS it — that is what an older apollo-service deploy looks like on the wire.
  degraded?: boolean;
}

// "One filter vocabulary" Wave 2: human-service runs ONLY Layer 1 (via
// chat-service /complete) and then asks apollo-service to BUILD + COUNT a
// faithful Apollo audience for it (POST /audiences/suggest-from-segment). No
// in-human-service Layer-2 loop / vocabulary anymore.
//
// Layer 1 emits ONE audience (the split is deferred to the post-validation
// A/B-split step, #235), so `segments` here is a one-element list; a longer one
// exercises the "keep the first" guard.
//
// Mock both:
// - chat-service /complete (Layer 1 — systemPrompt mentions "ONE target audience"): segments.
// - apollo-service /audiences/suggest-from-segment: {apolloAudienceId, filters, count}.
// The description every relabel returns unless a test overrides it.
const RELABELLED = "relabelled from the final filters";

function wire(opts: {
  segments: Array<{ name: string; description: string }>;
  apollo?: (name: string, description: string) => ApolloResp | "503";
  relabel?: ((message: string) => string) | "fail";
}) {
  let seq = 0;
  const defaultApollo = (name: string): ApolloResp => ({
    apolloAudienceId: `apollo-aud-${++seq}`,
    filters: { personTitles: [name] },
    count: 100,
  });
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/complete")) {
      const body = JSON.parse(init.body ?? "{}") as {
        systemPrompt: string;
        message: string;
      };
      // The relabel-from-final-filters call (#234) — ORG-BILLED, so it rides the
      // same /complete path as layer 1 and is told apart by its system prompt.
      if (body.systemPrompt.includes("SINGLE concise sentence")) {
        if (opts.relabel === "fail") return err(503, "chat overloaded");
        return ok({
          json: { description: opts.relabel?.(body.message) ?? RELABELLED },
        });
      }
      if (body.systemPrompt.includes("ONE target audience")) {
        return ok({
          json: { audiences: opts.segments },
          content: "",
          tokensInput: 1,
          tokensOutput: 1,
          model: "gemini-flash",
        });
      }
      throw new Error("unexpected /complete (no layer-2 in the pointer model)");
    }
    if (u.endsWith("/audiences/suggest-from-segment")) {
      const body = JSON.parse(init.body ?? "{}") as {
        name: string;
        description: string;
      };
      const r = (opts.apollo ?? defaultApollo)(body.name, body.description);
      return r === "503" ? err(503, "apollo overloaded") : ok(r);
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
  it("returns exactly ONE audience, in an array", async () => {
    wire({
      segments: [{ name: "Swiss Drogerien", description: "owners of drugstores in Switzerland" }],
    });
    const res = await suggest("drugstores in German-speaking Switzerland");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.candidates)).toBe(true);
    expect(res.body.candidates).toHaveLength(1);
    const c = res.body.candidates[0];
    expect(c.name).toBe("Swiss Drogerien");
    expect(c.audienceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.status).toBe("suggested");
    expect(c.provider).toBe("apollo"); // always apollo (pointer model)
    expect(c.apolloAudienceId).toMatch(/^apollo-aud-/);
    expect(c.validationError).toBeNull();
    expect(c.truncated).toBe(false);
    expect(res.body.failedSegments).toEqual([]);

    // ONE apollo build, ONE persisted row — no fan-out.
    const builds = fetchSpy.mock.calls.filter(([url]) =>
      String(url).endsWith("/audiences/suggest-from-segment")
    );
    expect(builds).toHaveLength(1);
    const rows = await db.select().from(audiences);
    expect(rows).toHaveLength(1);
  });

  it("keeps only the FIRST audience when layer 1 over-produces", async () => {
    wire({
      segments: [
        { name: "US companies", description: "companies in the US" },
        { name: "Europe companies", description: "companies in Europe" },
      ],
    });
    const res = await suggest("companies in US and Europe");
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0].name).toBe("US companies");
    const rows = await db.select().from(audiences);
    expect(rows).toHaveLength(1);
  });

  it("returns + persists the apollo-service pointer, faithful filters and count", async () => {
    wire({
      segments: [{ name: "Fintech CMOs", description: "CMOs in fintech" }],
      apollo: () => ({
        apolloAudienceId: "apollo-xyz",
        filters: {
          personTitles: ["CMO"],
          qOrganizationIndustryTagIds: ["Financial Services"],
          revenueRange: ["1000000,10000000"],
        },
        count: 1234,
      }),
    });
    const res = await suggest("CMOs in fintech");
    expect(res.status).toBe(200);
    const c = res.body.candidates[0];
    expect(c.provider).toBe("apollo");
    expect(c.apolloAudienceId).toBe("apollo-xyz");
    expect(c.count).toBe(1234);
    // The faithful Apollo filter object is echoed back verbatim (opaque).
    expect(c.filters).toEqual({
      personTitles: ["CMO"],
      qOrganizationIndustryTagIds: ["Financial Services"],
      revenueRange: ["1000000,10000000"],
    });

    // Persisted row carries the pointer + cached faithful filters + count.
    const persisted = await request(app)
      .get(`/orgs/audiences/${c.audienceId}`)
      .set(getAuthHeaders());
    expect(persisted.status).toBe(200);
    expect(persisted.body.audience.apolloAudienceId).toBe("apollo-xyz");
    expect(persisted.body.audience.provider).toBe("apollo");
    expect(persisted.body.audience.apolloCount).toBe(1234);
    expect(persisted.body.audience.filters).toEqual(c.filters);
  });

  it("calls apollo-service suggest-from-segment with the segment name + description + brandId", async () => {
    const segmentCalls: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/complete")) {
        if (
          (JSON.parse(init.body ?? "{}") as { systemPrompt?: string }).systemPrompt?.includes(
            "SINGLE concise sentence"
          )
        )
          return ok({ json: { description: RELABELLED } });
        return ok({
          json: {
            audiences: [
              { name: "Fintech CTOs", description: "CTOs at US fintech firms" },
            ],
          },
        });
      }
      if (u.endsWith("/audiences/suggest-from-segment")) {
        segmentCalls.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
        return ok({ apolloAudienceId: "a1", filters: { personTitles: ["CTO"] }, count: 42 });
      }
      throw new Error("unexpected url " + u);
    });
    const res = await suggest("CTOs in fintech");
    expect(res.status).toBe(200);
    expect(segmentCalls).toHaveLength(1);
    expect(segmentCalls[0]).toEqual({
      name: "Fintech CTOs",
      description: "CTOs at US fintech firms",
      brandId: BRAND,
    });
  });

  it("rejects a zero-count apollo build instead of persisting an unusable suggested audience", async () => {
    wire({
      segments: [{ name: "Impossible", description: "nobody" }],
      // apollo-service returns a valid (non-empty) filter object with count 0.
      apollo: () => ({ apolloAudienceId: "a0", filters: { personTitles: ["Nobody"] }, count: 0 }),
    });
    const res = await suggest("impossible audience");
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("unusable audience build");

    const rows = await db.select().from(audiences);
    expect(rows).toHaveLength(0);
  });

  it("prompts layer 1 for ONE audience and keeps the single-audience rules live", async () => {
    wire({ segments: [{ name: "Swiss Drogerien", description: "drugstore owners" }] });
    const res = await suggest(
      "everyone relevant to buy psyllium husks in drugstores and organic shops in German-speaking Switzerland"
    );
    expect(res.status).toBe(200);
    const layer1Call = fetchSpy.mock.calls
      .filter(([url]) => String(url).endsWith("/complete"))
      .map(([, init]) => JSON.parse(init?.body ?? "{}") as { systemPrompt: string })
      .find((body) => body.systemPrompt.includes("ONE target audience"));
    expect(layer1Call?.systemPrompt).toContain("You do NOT split it");
    expect(layer1Call?.systemPrompt).toContain("EXACTLY ONE audience");
    // The rules that shipped in #236 / #237 / #238 stay live for one audience.
    expect(layer1Call?.systemPrompt).toContain("PRODUCT is NEVER a targeting attribute");
    expect(layer1Call?.systemPrompt).toContain("BUYING INTENT IS NOT A JOB TITLE");
    expect(layer1Call?.systemPrompt).toContain(
      "describes ONE population, never a union of several"
    );
    expect(layer1Call?.systemPrompt).toContain("EVERY CONSTRAINT IS STATED POSITIVELY");
    // No numeric audience-count target survives in the layer-1 prompt.
    expect(layer1Call?.systemPrompt).not.toMatch(/ballpark|6-8/);
  });

  it("persists candidates at status 'suggested' (inactive) and exposes them via GET ?status=suggested", async () => {
    wire({ segments: [{ name: "Alpha", description: "alpha" }] });
    const res = await suggest("alpha");
    expect(res.status).toBe(200);
    const ids = res.body.candidates.map((c: { audienceId: string }) => c.audienceId);

    const suggested = await request(app)
      .get(`/orgs/audiences?brandId=${BRAND}&status=suggested`)
      .set(getAuthHeaders());
    expect(suggested.status).toBe(200);
    expect(suggested.body.audiences).toHaveLength(1);

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
      apollo: () => ({ apolloAudienceId: "apollo-repeat", filters: { personTitles: ["X"] }, count: 11 }),
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

  it("calls chat-service Layer 1 with google JSON mode, a responseSchema, flash + thinking disabled", async () => {
    const completeBodies: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/complete")) {
        if (
          (JSON.parse(init.body ?? "{}") as { systemPrompt?: string }).systemPrompt?.includes(
            "SINGLE concise sentence"
          )
        )
          return ok({ json: { description: RELABELLED } });
        const body = JSON.parse(init.body ?? "{}");
        completeBodies.push(body);
        return ok({ json: { audiences: [{ name: "CMOs", description: "cmos" }] } });
      }
      if (u.endsWith("/audiences/suggest-from-segment"))
        return ok({ apolloAudienceId: "a1", filters: { personTitles: ["CMO"] }, count: 50 });
      throw new Error("unexpected url " + u);
    });
    const res = await suggest("CMOs");
    expect(res.status).toBe(200);
    // ONLY Layer 1 hits chat-service now — no Layer-2 fan-out.
    expect(completeBodies).toHaveLength(1);
    const body = completeBodies[0];
    expect(body.provider).toBe("google");
    expect(body.responseFormat).toBe("json");
    expect(body.model).toBe("flash");
    expect(body.disableThinking).toBe(true);
    expect((body.responseSchema as { type?: string }).type).toBe("object");
    expect(body.systemPrompt).toContain("ONE target audience");
  });

  it("retries a transient chat-service 502 (malformed-JSON / blip) on Layer 1 and still succeeds", async () => {
    let layer1Calls = 0;
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/complete")) {
        if (
          (JSON.parse(init.body ?? "{}") as { systemPrompt?: string }).systemPrompt?.includes(
            "SINGLE concise sentence"
          )
        )
          return ok({ json: { description: RELABELLED } });
        const body = JSON.parse(init.body ?? "{}") as { systemPrompt: string };
        if (body.systemPrompt.includes("ONE target audience")) {
          layer1Calls++;
          if (layer1Calls === 1) return err(502, "model returned non-parsable JSON");
          return ok({ json: { audiences: [{ name: "CMOs", description: "cmos" }] } });
        }
        throw new Error("unexpected /complete");
      }
      if (u.endsWith("/audiences/suggest-from-segment"))
        return ok({ apolloAudienceId: "a1", filters: { personTitles: ["CMO"] }, count: 100 });
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

  it("fails LOUD when the single apollo build fails — never an empty list", async () => {
    wire({
      segments: [{ name: "Swiss Drogerien", description: "drugstore owners" }],
      apollo: () => "503",
    });
    const res = await suggest("drugstores in Switzerland");
    expect(res.status).toBe(502);
    expect(res.body.candidates).toBeUndefined();
    const rows = await db.select().from(audiences);
    expect(rows).toHaveLength(0);
  });

  it("502 when the apollo-service build fails", async () => {
    wire({
      segments: [{ name: "X", description: "x" }],
      apollo: () => "503",
    });
    const res = await suggest("anyone");
    expect(res.status).toBe(502);
  });

  it("502 when chat-service env is not configured", async () => {
    delete process.env.CHAT_SERVICE_URL;
    wire({ segments: [{ name: "X", description: "x" }] });
    const res = await suggest("anyone");
    expect(res.status).toBe(502);
  });

  // --- #234: the stored label is derived from the FINAL filters ---

  it("relabels the persisted description from the audience's final filters, not from layer 1", async () => {
    wire({
      segments: [
        { name: "Swiss Drogerien", description: "layer-1 input specification" },
      ],
      apollo: () => ({
        apolloAudienceId: "a-swiss",
        filters: { organizationKeywords: ["drogerie"] },
        count: 42,
      }),
      relabel: (message) => {
        // The relabel sees the row's own name + the FINAL filters — never the
        // layer-1 description, and never the batch nlPrompt.
        expect(message).toContain("Swiss Drogerien");
        expect(message).toContain("drogerie");
        expect(message).not.toContain("layer-1 input specification");
        return "owners of independent drugstores in Switzerland";
      },
    });
    const res = await suggest("psyllium buyers in swiss drugstores");
    expect(res.status).toBe(200);
    expect(res.body.candidates[0].rationale).toBe(
      "owners of independent drugstores in Switzerland"
    );
    const [row] = await db.select().from(audiences);
    expect(row.description).toBe("owners of independent drugstores in Switzerland");
  });

  it("fails the request (no fallback) when the relabel call fails", async () => {
    wire({ segments: [{ name: "Alpha", description: "a" }], relabel: "fail" });
    const res = await suggest("alpha");
    expect(res.status).toBe(502); // the build failed — reported, never silent
  });

  // --- #234: a partial batch says which segments were lost ---

  it("reports the failure to the caller (502 + reason) rather than an empty batch", async () => {
    wire({
      segments: [{ name: "Bad", description: "bad seg" }],
      apollo: () => "503",
    });
    const res = await suggest("bad");
    expect(res.status).toBe(502);
    expect(res.body.error).toBeTruthy();
  });

  it("returns an EMPTY failedSegments when the build succeeded", async () => {
    wire({ segments: [{ name: "Alpha", description: "a" }] });
    const res = await suggest("alpha");
    expect(res.status).toBe(200);
    expect(res.body.failedSegments).toEqual([]);
  });

  // --- degraded: apollo-service's verdict, carried through and persisted ---

  it("carries degraded:true onto the candidate AND the persisted row", async () => {
    wire({
      segments: [{ name: "Off Target", description: "nobody the grader liked" }],
      apollo: () => ({
        apolloAudienceId: "apollo-degraded",
        filters: { personTitles: ["Anything"] },
        count: 42,
        degraded: true,
      }),
    });
    const res = await suggest("something the builder cannot hit");
    expect(res.status).toBe(200);
    expect(res.body.candidates[0].degraded).toBe(true);
    // Not a gate: the audience is still built, still persisted, still suggested.
    expect(res.body.candidates[0].status).toBe("suggested");
    const rows = await db.select().from(audiences);
    expect(rows).toHaveLength(1);
    expect(rows[0].degraded).toBe(true);
  });

  it("round-trips degraded on a later read of the audience", async () => {
    wire({
      segments: [{ name: "Off Target", description: "nobody the grader liked" }],
      apollo: () => ({
        apolloAudienceId: "apollo-degraded",
        filters: { personTitles: ["Anything"] },
        count: 42,
        degraded: true,
      }),
    });
    const suggested = await suggest("something the builder cannot hit");
    const audienceId = suggested.body.candidates[0].audienceId as string;

    const read = await request(app)
      .get(`/orgs/audiences/${audienceId}`)
      .set(getAuthHeaders());
    expect(read.status).toBe(200);
    expect(read.body.audience.degraded).toBe(true);
  });

  it("treats an apollo-service response WITHOUT the field as degraded:false", async () => {
    // The default mock omits `degraded` entirely — an older apollo-service deploy.
    wire({ segments: [{ name: "Fine", description: "a good audience" }] });
    const res = await suggest("a good audience");
    expect(res.status).toBe(200);
    expect(res.body.candidates[0].degraded).toBe(false);
    const rows = await db.select().from(audiences);
    expect(rows[0].degraded).toBe(false);
  });

  it("400 when nlPrompt is missing", async () => {
    const res = await request(app)
      .post("/orgs/audiences/suggest")
      .set(getAuthHeaders())
      .send({ brandId: BRAND });
    expect(res.status).toBe(400);
  });
});
