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
}

// "One filter vocabulary" Wave 2: human-service runs ONLY Layer 1 (segment
// decompose, via chat-service /complete) and then asks apollo-service to BUILD +
// COUNT a faithful Apollo audience per segment (POST /audiences/suggest-from-
// segment). No in-human-service Layer-2 loop / vocabulary anymore.
//
// Mock both:
// - chat-service /complete (Layer 1 — systemPrompt mentions "decompose"): segments.
// - apollo-service /audiences/suggest-from-segment: {apolloAudienceId, filters, count}.
function wire(opts: {
  segments: Array<{ name: string; description: string }>;
  apollo?: (name: string, description: string) => ApolloResp | "503";
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
      const body = JSON.parse(init.body ?? "{}") as { systemPrompt: string };
      if (body.systemPrompt.includes("decompose a natural-language audience")) {
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
  it("layer 1 decomposes into N named audiences; one apollo candidate per audience", async () => {
    wire({
      segments: [
        { name: "US companies", description: "companies in the US" },
        { name: "Europe companies", description: "companies in Europe" },
      ],
    });
    const res = await suggest("companies in US and Europe separately");
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(2);
    const names = res.body.candidates.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(["Europe companies", "US companies"]);
    for (const c of res.body.candidates) {
      expect(c.audienceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.status).toBe("suggested");
      expect(c.provider).toBe("apollo"); // always apollo (pointer model)
      expect(c.apolloAudienceId).toMatch(/^apollo-aud-/);
      expect(c.validationError).toBeNull();
      expect(c.truncated).toBe(false);
    }
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

  it("keeps every layer-1 audience and prompts for persona x company-type combinations", async () => {
    wire({
      segments: [
        { name: "B2B SaaS Founders", description: "Founders at B2B SaaS" },
        { name: "Digital Founders", description: "Founders at digital product cos" },
        { name: "B2B SaaS Growth", description: "Heads of Growth at B2B SaaS" },
        { name: "Digital Growth", description: "Heads of Growth at digital product cos" },
        { name: "B2B SaaS Solo", description: "Solo marketers at B2B SaaS" },
        { name: "Digital Solo", description: "Solo marketers at digital product cos" },
      ],
    });
    const res = await suggest(
      "Founders, Heads of Growth, or Solo Marketers at bootstrapped or seed-stage B2B SaaS and digital product companies"
    );
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(6);
    expect(res.body.candidates.every((c: { truncated: boolean }) => c.truncated)).toBe(
      false
    );
    const layer1Call = fetchSpy.mock.calls
      .filter(([url]) => String(url).endsWith("/complete"))
      .map(([, init]) => JSON.parse(init?.body ?? "{}") as { systemPrompt: string })
      .find((body) =>
        body.systemPrompt.includes("decompose a natural-language audience")
      );
    expect(layer1Call?.systemPrompt).toContain(
      "When multiple independent axes are explicitly present"
    );
    expect(layer1Call?.systemPrompt).toMatch(
      /Example: 3 personas\s+x 2 company types = 6 audiences/
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
    expect(body.systemPrompt).toContain("decompose a natural-language audience");
  });

  it("retries a transient chat-service 502 (malformed-JSON / blip) on Layer 1 and still succeeds", async () => {
    let layer1Calls = 0;
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/complete")) {
        const body = JSON.parse(init.body ?? "{}") as { systemPrompt: string };
        if (body.systemPrompt.includes("decompose a natural-language audience")) {
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

  it("tolerates one segment's apollo-service failure and still returns the others", async () => {
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/complete")) {
        return ok({
          json: {
            audiences: [
              { name: "Good", description: "good seg" },
              { name: "Bad", description: "bad seg" },
            ],
          },
        });
      }
      if (u.endsWith("/audiences/suggest-from-segment")) {
        const body = JSON.parse(init.body ?? "{}") as { description: string };
        // Persistent 5xx for the Bad segment (survives the connect retry budget).
        if (body.description.includes("bad seg")) return err(503, "apollo overloaded");
        return ok({ apolloAudienceId: "a-good", filters: { personTitles: ["X"] }, count: 300 });
      }
      throw new Error("unexpected url " + u);
    });
    const res = await suggest("good and bad");
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1); // Bad dropped, Good kept
    expect(res.body.candidates[0].name).toBe("Good");
  });

  it("502 when every segment's apollo-service build fails", async () => {
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

  it("400 when nlPrompt is missing", async () => {
    const res = await request(app)
      .post("/orgs/audiences/suggest")
      .set(getAuthHeaders())
      .send({ brandId: BRAND });
    expect(res.status).toBe(400);
  });
});
