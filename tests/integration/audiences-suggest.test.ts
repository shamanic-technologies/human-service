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

interface ApolloCandidateResp {
  apolloAudienceId: string;
  filters: Record<string, unknown>;
  count: number;
  sample?: Array<{ company: string | null; title: string | null }>;
  notes?: {
    whatWorked?: string;
    whatToImprove?: string;
    nextExperiment?: string;
  };
}

interface ApolloResp {
  apolloAudienceId: string;
  filters: Record<string, unknown>;
  count: number;
  // apollo-service#228: additive on their side, so the default mock deliberately
  // OMITS it — that is what an older apollo-service deploy looks like on the wire.
  degraded?: boolean;
  // Every round apollo-service explored. ALSO additive: the default mock omits
  // it, which is what a pre-chooser apollo-service deploy looks like on the wire
  // (the client then synthesises ONE candidate from the legacy fields).
  candidates?: ApolloCandidateResp[];
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
// The description the chooser writes unless a test overrides it.
const CHOSEN_DESCRIPTION = "written by the chooser from the chosen filters";
// The name the chooser writes in the inline mocks that do not assert on it.
const CHOSEN_NAME = "Chosen Audience";
// The chooser's system prompt is told apart from layer 1's by this phrase.
const CHOOSER_MARKER = "YOU PICK EXACTLY ONE";

interface ChooserAnswer {
  chosen?: unknown;
  why?: string;
  // One sentence per attempt, including the ones it did not take. Omitted ⇒ the
  // harness synthesises full coverage from the attempt count in the message.
  rationales?: unknown;
  name?: string;
  description?: string;
  degraded?: boolean;
  degradedReason?: string;
}

// Full coverage, derived from the rendered candidate list, so every inline mock
// answers the way a real chooser must: a sentence for every attempt.
function defaultRationales(message: string): Array<{ attempt: number; rationale: string }> {
  const n = Number(/THE (\d+) ATTEMPTS/.exec(message)?.[1] ?? "1");
  return Array.from({ length: n }, (_, i) => ({
    attempt: i + 1,
    rationale: `attempt ${i + 1}: accounted for by the test harness`,
  }));
}

function wire(opts: {
  segments: Array<{ name: string; description: string }>;
  apollo?: (name: string, description: string) => ApolloResp | "503";
  // The chooser sees the rendered candidate list; a test can inspect it and
  // answer differently. "fail" makes chat-service reject the chooser call.
  chooser?: ((message: string) => ChooserAnswer) | "fail";
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
      // The CHOOSER call — ORG-BILLED, so it rides the same /complete path as
      // layer 1 and is told apart by its system prompt. It picks the audience
      // AND writes the name + description persisted for it (there is no
      // separate relabel call any more).
      if (body.systemPrompt.includes(CHOOSER_MARKER)) {
        if (opts.chooser === "fail") return err(503, "chat overloaded");
        const answer = opts.chooser?.(body.message) ?? {};
        return ok({
          json: {
            chosen: answer.chosen ?? 1,
            why: answer.why ?? "its sample is recognisably the target",
            rationales: answer.rationales ?? defaultRationales(body.message),
            name: answer.name ?? opts.segments[0].name,
            description: answer.description ?? CHOSEN_DESCRIPTION,
            degraded: answer.degraded ?? false,
            degradedReason: answer.degradedReason ?? "",
          },
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
            CHOOSER_MARKER
          )
        )
          return ok({
            json: {
              chosen: 1,
              why: "w",
              rationales: [{ attempt: 1, rationale: "the only attempt offered" }],
              name: CHOSEN_NAME,
              description: CHOSEN_DESCRIPTION,
              degraded: false,
            },
          });
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
            CHOOSER_MARKER
          )
        )
          return ok({
            json: {
              chosen: 1,
              why: "w",
              rationales: [{ attempt: 1, rationale: "the only attempt offered" }],
              name: CHOSEN_NAME,
              description: CHOSEN_DESCRIPTION,
              degraded: false,
            },
          });
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
            CHOOSER_MARKER
          )
        )
          return ok({
            json: {
              chosen: 1,
              why: "w",
              rationales: [{ attempt: 1, rationale: "the only attempt offered" }],
              name: CHOSEN_NAME,
              description: CHOSEN_DESCRIPTION,
              degraded: false,
            },
          });
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

  // --- the chooser picks, and the SAME call writes the stored label ---

  it("persists the name + description the chooser wrote, in ONE call — no separate relabel", async () => {
    wire({
      segments: [
        { name: "Layer One Name", description: "layer-1 input specification" },
      ],
      apollo: () => ({
        apolloAudienceId: "a-swiss",
        filters: { organizationKeywords: ["drogerie"] },
        count: 42,
      }),
      chooser: (message) => {
        // The chooser sees the client's request verbatim + the attempts it is
        // choosing between (their filters), and writes both labels itself.
        expect(message).toContain("psyllium buyers in swiss drugstores");
        expect(message).toContain("drogerie");
        return {
          name: "Swiss Drogerien",
          description: "owners of independent drugstores in Switzerland",
        };
      },
    });
    const res = await suggest("psyllium buyers in swiss drugstores");
    expect(res.status).toBe(200);
    expect(res.body.candidates[0].name).toBe("Swiss Drogerien");
    expect(res.body.candidates[0].rationale).toBe(
      "owners of independent drugstores in Switzerland"
    );
    const [row] = await db.select().from(audiences);
    expect(row.name).toBe("Swiss Drogerien");
    expect(row.description).toBe("owners of independent drugstores in Switzerland");

    // Exactly TWO chat-service calls: layer 1 and the chooser. A third would be
    // the relabel this replaced.
    const completes = fetchSpy.mock.calls.filter(([url]) =>
      String(url).endsWith("/complete")
    );
    expect(completes).toHaveLength(2);
  });

  it("fails the request (no fallback) when the chooser call fails", async () => {
    wire({ segments: [{ name: "Alpha", description: "a" }], chooser: "fail" });
    const res = await suggest("alpha");
    expect(res.status).toBe(502); // reported, never silently picked in code
    const rows = await db.select().from(audiences);
    expect(rows).toHaveLength(0);
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

  // --- degraded: the CHOOSER's verdict, carried through and persisted ---

  it("carries the chooser's degraded:true onto the candidate AND the persisted row", async () => {
    wire({
      segments: [{ name: "Off Target", description: "nobody the chooser liked" }],
      apollo: () => ({
        apolloAudienceId: "apollo-degraded",
        filters: { personTitles: ["Anything"] },
        count: 42,
      }),
      chooser: () => ({ degraded: true }),
    });
    const res = await suggest("something no attempt really answers");
    expect(res.status).toBe(200);
    expect(res.body.candidates[0].degraded).toBe(true);
    // Not a gate: an audience is still chosen, still persisted, still suggested.
    expect(res.body.candidates[0].status).toBe("suggested");
    expect(res.body.candidates[0].apolloAudienceId).toBe("apollo-degraded");
    const rows = await db.select().from(audiences);
    expect(rows).toHaveLength(1);
    expect(rows[0].degraded).toBe(true);
  });

  it("round-trips degraded on a later read of the audience", async () => {
    wire({
      segments: [{ name: "Off Target", description: "nobody the chooser liked" }],
      chooser: () => ({ degraded: true }),
    });
    const suggested = await suggest("something no attempt really answers");
    const audienceId = suggested.body.candidates[0].audienceId as string;

    const read = await request(app)
      .get(`/orgs/audiences/${audienceId}`)
      .set(getAuthHeaders());
    expect(read.status).toBe(200);
    expect(read.body.audience.degraded).toBe(true);
  });

  it("treats a chooser answer WITHOUT the field as degraded:false", async () => {
    wire({
      segments: [{ name: "Fine", description: "a good audience" }],
      chooser: () => ({ degraded: undefined }),
    });
    const res = await suggest("a good audience");
    expect(res.status).toBe(200);
    expect(res.body.candidates[0].degraded).toBe(false);
    const rows = await db.select().from(audiences);
    expect(rows[0].degraded).toBe(false);
  });

  // --- the chooser sees every attempt, and its pick is what gets persisted ---

  const THREE_CANDIDATES: ApolloCandidateResp[] = [
    {
      apolloAudienceId: "apollo-huge",
      filters: { qOrganizationKeywordTags: ["retail"] },
      count: 179156,
      sample: [
        { company: "Mars", title: "Procurement Manager" },
        { company: "Lidl", title: "Category Buyer" },
        { company: "Bucherer", title: "Store Manager" },
        { company: "Manor", title: "Head of Purchasing" },
      ],
      notes: {
        whatWorked: "broad retail tags returned a lot of people",
        whatToImprove: "the sample is multinationals, not independent shops",
        nextExperiment: "tighten to drugstore keyword tags",
      },
    },
    {
      apolloAudienceId: "apollo-tight",
      filters: { qOrganizationKeywordTags: ["drogerie", "reformhaus"] },
      count: 659,
      sample: [
        { company: "Abderhalden Drogerie AG", title: "Inhaber" },
        { company: "Bio Partner Schweiz", title: "Geschaeftsfuehrer" },
        { company: "DR. BAEHLER DROPA", title: "Filialleiter" },
      ],
      notes: {
        whatWorked: "drugstore tags matched recognisable independents",
        whatToImprove: "volume is small",
        nextExperiment: "keep it and stop",
      },
    },
    {
      apolloAudienceId: "apollo-empty-ish",
      filters: { personTitles: ["Chief Medical Officer"] },
      count: 12,
      sample: [{ company: "Kantonsspital", title: "Chief Medical Officer" }],
    },
  ];

  it("shows the chooser every attempt with its count, its sample rows and its notes", async () => {
    let seen = "";
    wire({
      segments: [{ name: "Swiss Drogerien", description: "drugstore owners" }],
      apollo: () => ({
        apolloAudienceId: "apollo-huge",
        filters: THREE_CANDIDATES[0].filters,
        count: 179156,
        candidates: THREE_CANDIDATES,
      }),
      chooser: (message) => {
        seen = message;
        return { chosen: 2 };
      },
    });
    const res = await suggest("drugstores and organic shops in German-speaking Switzerland");
    expect(res.status).toBe(200);

    // The client's request verbatim.
    expect(seen).toContain("drugstores and organic shops in German-speaking Switzerland");
    // All THREE attempts — never a hidden subset.
    expect(seen).toContain("ATTEMPT 1");
    expect(seen).toContain("ATTEMPT 2");
    expect(seen).toContain("ATTEMPT 3");
    // Counts.
    expect(seen).toContain("179156");
    expect(seen).toContain("659");
    // Samples — the whole point.
    expect(seen).toContain("Mars");
    expect(seen).toContain("Abderhalden Drogerie AG");
    expect(seen).toContain("Procurement Manager");
    // Notes.
    expect(seen).toContain("drugstore tags matched recognisable independents");
    expect(seen).toContain("the sample is multinationals, not independent shops");
  });

  it("persists the attempt the chooser named, even when it is far from the largest", async () => {
    wire({
      segments: [{ name: "Swiss Drogerien", description: "drugstore owners" }],
      apollo: () => ({
        // The legacy top-level fields still carry the biggest set; they are NOT
        // what gets persisted once the chooser has named one.
        apolloAudienceId: "apollo-huge",
        filters: THREE_CANDIDATES[0].filters,
        count: 179156,
        candidates: THREE_CANDIDATES,
      }),
      chooser: () => ({ chosen: 2, name: "Swiss Drogerien" }),
    });
    const res = await suggest("drugstores in German-speaking Switzerland");
    expect(res.status).toBe(200);
    const c = res.body.candidates[0];
    expect(c.apolloAudienceId).toBe("apollo-tight");
    expect(c.count).toBe(659);
    expect(c.filters).toEqual({ qOrganizationKeywordTags: ["drogerie", "reformhaus"] });

    const [row] = await db.select().from(audiences);
    expect(row.apolloAudienceId).toBe("apollo-tight");
    expect(row.apolloCount).toBe(659);
  });

  it("persists the WHOLE decision on the chosen row — every attempt, with its rationale", async () => {
    wire({
      segments: [{ name: "Swiss Drogerien", description: "drugstore owners" }],
      apollo: () => ({
        apolloAudienceId: "apollo-huge",
        filters: THREE_CANDIDATES[0].filters,
        count: 179156,
        candidates: THREE_CANDIDATES,
      }),
      chooser: () => ({
        chosen: 2,
        why: "its sample is recognisably Swiss drugstores",
        rationales: [
          { attempt: 1, rationale: "179k people, but Mars and Lidl are not drugstores" },
          { attempt: 2, rationale: "the independents the client described" },
          { attempt: 3, rationale: "hospital CMOs, a different profession entirely" },
        ],
        name: "Swiss Drogerien",
        degraded: true,
        degradedReason: "no attempt enumerated the German-speaking cantons",
      }),
    });
    const res = await suggest("drugstores in German-speaking Switzerland");
    expect(res.status).toBe(200);

    const [row] = await db.select().from(audiences);
    const trace = row.chooserTrace as Record<string, unknown>;
    expect(trace).toBeTruthy();
    // The overall verdict.
    expect(trace.chosen).toBe(2);
    expect(trace.why).toBe("its sample is recognisably Swiss drugstores");
    expect(trace.degraded).toBe(true);
    expect(trace.degradedReason).toBe(
      "no attempt enumerated the German-speaking cantons"
    );
    // Every candidate — the rejected ones are the whole point.
    const rows = trace.candidates as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.count)).toEqual([179156, 659, 12]);
    expect(rows.map((r) => r.chosen)).toEqual([false, true, false]);
    expect(rows[0].rationale).toContain("Mars and Lidl are not drugstores");
    expect(rows[0].apolloAudienceId).toBe("apollo-huge");
    expect(rows[0].filterFields).toEqual(["qOrganizationKeywordTags"]);
    expect((rows[1].sample as unknown[]).length).toBeGreaterThan(0);
  });

  it("502s when the chooser leaves an attempt unaccounted for", async () => {
    wire({
      segments: [{ name: "Alpha", description: "a" }],
      apollo: () => ({
        apolloAudienceId: "apollo-huge",
        filters: { personTitles: ["X"] },
        count: 10,
        candidates: THREE_CANDIDATES,
      }),
      // Only the pick is justified — the two it passed over are not.
      chooser: () => ({
        chosen: 2,
        rationales: [{ attempt: 2, rationale: "the one I took" }],
      }),
    });
    const res = await suggest("alpha");
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("attempt(s) 1, 3");
    const rows = await db.select().from(audiences);
    expect(rows).toHaveLength(0);
  });

  it("502s when the chooser names an attempt that was not offered", async () => {
    wire({
      segments: [{ name: "Alpha", description: "a" }],
      apollo: () => ({
        apolloAudienceId: "apollo-huge",
        filters: { personTitles: ["X"] },
        count: 10,
        candidates: THREE_CANDIDATES,
      }),
      chooser: () => ({ chosen: 9 }),
    });
    const res = await suggest("alpha");
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("not one of the 3 offered");
    const rows = await db.select().from(audiences);
    expect(rows).toHaveLength(0);
  });

  it("still works against an apollo-service deploy that sends NO candidates array", async () => {
    // The legacy single result becomes the one attempt the chooser is offered.
    let seen = "";
    wire({
      segments: [{ name: "Legacy", description: "legacy" }],
      apollo: () => ({
        apolloAudienceId: "apollo-legacy",
        filters: { personTitles: ["CEO"] },
        count: 77,
      }),
      chooser: (message) => {
        seen = message;
        return { chosen: 1, name: "Legacy" };
      },
    });
    const res = await suggest("legacy");
    expect(res.status).toBe(200);
    expect(seen).toContain("THE 1 ATTEMPTS");
    expect(seen).toContain("none supplied for this attempt");
    expect(res.body.candidates[0].apolloAudienceId).toBe("apollo-legacy");
    expect(res.body.candidates[0].count).toBe(77);
  });

  it("calls the chooser on google/pro with a responseSchema and thinking left ON", async () => {
    wire({ segments: [{ name: "Alpha", description: "a" }] });
    const res = await suggest("alpha");
    expect(res.status).toBe(200);
    const chooserBody = fetchSpy.mock.calls
      .filter(([url]) => String(url).endsWith("/complete"))
      .map(([, init]) => JSON.parse(init?.body ?? "{}") as Record<string, unknown>)
      .find((b) => String(b.systemPrompt).includes(CHOOSER_MARKER));
    expect(chooserBody).toBeTruthy();
    expect(chooserBody!.provider).toBe("google");
    expect(chooserBody!.model).toBe("pro");
    expect(chooserBody!.responseFormat).toBe("json");
    // A comparative judgement is reasoning, not extraction — thinking stays on.
    expect(chooserBody!.disableThinking).toBeUndefined();
    expect((chooserBody!.responseSchema as { required?: string[] }).required).toEqual([
      "chosen",
      "why",
      "rationales",
      "name",
      "description",
      "degraded",
      "degradedReason",
    ]);
    // The choice is written BEFORE any per-attempt sentence — a per-candidate
    // grade asked first is the shape that degenerated three times upstream.
    expect(
      (chooserBody!.responseSchema as { propertyOrdering?: string[] }).propertyOrdering
    ).toEqual([
      "chosen",
      "why",
      "rationales",
      "name",
      "description",
      "degraded",
      "degradedReason",
    ]);
  });

  it("400 when nlPrompt is missing", async () => {
    const res = await request(app)
      .post("/orgs/audiences/suggest")
      .set(getAuthHeaders())
      .send({ brandId: BRAND });
    expect(res.status).toBe(400);
  });
});
