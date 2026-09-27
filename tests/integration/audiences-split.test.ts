// The new-campaign modal's split: a confirmed target text -> up to 6
// non-overlapping segments (name, sentence, icon), then the kept ones become
// ACTIVE audiences under the brand + offer. Proposing makes NO provider call and
// persists nothing; confirming writes rows the existing Apollo pointer build
// picks up (provider apollo, no pointer, no filters).
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000b1";
const OFFER = "00000000-0000-4000-8000-0000000000c1";
const OFFER_2 = "00000000-0000-4000-8000-0000000000c2";

const fetchSpy = vi.fn();
const fetchBefore = globalThis.fetch;

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  await cleanTestData();
});

afterAll(async () => {
  globalThis.fetch = fetchBefore;
  await closeDb();
});

const TWO = [
  { name: "US SaaS founders", description: "Founders of B2B SaaS companies based in the United States." },
  { name: "Europe SaaS founders", description: "Founders of B2B SaaS companies based in Europe." },
];

function wire(split: { axes: string[]; segments: Array<{ name: string; description: string }> }) {
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/complete")) return ok({ json: split });
    if (u.endsWith("/orgs/judgments")) {
      const body = JSON.parse(init.body ?? "{}") as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((k, i) => [
          k,
          {
            type: "choice",
            choice: i === 0 ? "globe-hemisphere-west" : "globe-hemisphere-east",
            confidence: 0.9,
            probabilities: {},
          },
        ])
      );
      return ok({ model: "jev-latest", answers, usage: { inputTokens: 1, outputTokens: 0 } });
    }
    throw new Error("unexpected url " + u);
  });
}

function propose(targetAudience: string) {
  return request(app)
    .post("/orgs/audiences/split")
    .set(getAuthHeaders())
    .send({ brandId: BRAND, targetAudience });
}

function confirm(body: Record<string, unknown>) {
  return request(app)
    .post("/orgs/audiences/split/confirm")
    .set(getAuthHeaders())
    .send({ brandId: BRAND, offerId: OFFER, ...body });
}

describe("POST /orgs/audiences/split", () => {
  it("returns named, described, iconed segments from one completion + one judgment, and persists nothing", async () => {
    wire({ axes: ["geography"], segments: TWO });
    const res = await propose("B2B SaaS founders in the US and Europe");
    expect(res.status).toBe(200);
    expect(res.body.axes).toEqual(["geography"]);
    expect(res.body.segments).toEqual([
      { ...TWO[0], icon: "globe-hemisphere-west", iconConfidence: 0.9 },
      { ...TWO[1], icon: "globe-hemisphere-east", iconConfidence: 0.9 },
    ]);
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(["http://chat:8080/complete", "http://chat:8080/orgs/judgments"]);
    // The icon question offers the closed vocabulary.
    const judgment = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(Object.keys(judgment.questions)).toEqual(["segment_1", "segment_2"]);
    expect(judgment.questions.segment_1.type).toBe("choice");
    expect(judgment.questions.segment_1.criteria).toHaveProperty("globe-hemisphere-west");
    expect(await db.select().from(audiences)).toHaveLength(0);
  });

  it("a narrow target may return ONE segment, with no axis", async () => {
    wire({ axes: ["geography"], segments: [TWO[0]] });
    const res = await propose("B2B SaaS founders in Austin, Texas");
    expect(res.status).toBe(200);
    expect(res.body.segments).toHaveLength(1);
    expect(res.body.axes).toEqual([]);
  });

  it("fails loud (502) when the split exceeds 6 segments rather than truncating the partition", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ name: `S${i}`, description: `d${i}` }));
    wire({ axes: ["geography"], segments: seven });
    const res = await propose("everyone everywhere");
    expect(res.status).toBe(502);
  });

  it("fails loud (502) on an axis a people search cannot filter on", async () => {
    wire({ axes: ["buying_intent"], segments: TWO });
    expect((await propose("x")).status).toBe(502);
  });

  it("fails loud (502) when the judge names an icon outside the vocabulary", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/complete")) return ok({ json: { axes: [], segments: [TWO[0]] } });
      return ok({
        answers: { segment_1: { type: "choice", choice: "unicorn", confidence: 1, probabilities: {} } },
      });
    });
    expect((await propose("x")).status).toBe(502);
  });

  it("400s without a target", async () => {
    const res = await request(app)
      .post("/orgs/audiences/split")
      .set(getAuthHeaders())
      .send({ brandId: BRAND, targetAudience: "  " });
    expect(res.status).toBe(400);
  });
});

describe("POST /orgs/audiences/split/confirm", () => {
  it("creates N ACTIVE audiences under brand + offer carrying their descriptions", async () => {
    const res = await confirm({
      targetAudience: "B2B SaaS founders in the US and Europe",
      segments: TWO.map((s) => ({ ...s, icon: "map-pin", iconConfidence: 0.4 })),
    });
    expect(res.status).toBe(201);
    expect(res.body.audiences).toHaveLength(2);
    for (const [i, a] of res.body.audiences.entries()) {
      expect(a).toMatchObject({
        name: TWO[i].name,
        description: TWO[i].description,
        brandId: BRAND,
        offerId: OFFER,
        status: "active",
        provider: "apollo",
        apolloAudienceId: null,
        filters: null,
        nlPrompt: "B2B SaaS founders in the US and Europe",
        source: "split_proposal",
      });
    }
    const listed = await request(app)
      .get(`/orgs/audiences?offerId=${OFFER}&status=active`)
      .set(getAuthHeaders());
    expect(listed.body.audiences.map((a: { name: string }) => a.name).sort()).toEqual(
      TWO.map((s) => s.name).sort()
    );
  });

  it("is all-or-nothing: a name already taken under the offer 409s and writes nothing", async () => {
    expect((await confirm({ segments: [TWO[0]] })).status).toBe(201);
    const res = await confirm({ segments: [TWO[1], { ...TWO[0], name: "us saas FOUNDERS" }] });
    expect(res.status).toBe(409);
    expect(await db.select().from(audiences)).toHaveLength(1);
  });

  it("the same names under ANOTHER offer are fine", async () => {
    expect((await confirm({ segments: TWO })).status).toBe(201);
    expect((await confirm({ offerId: OFFER_2, segments: TWO })).status).toBe(201);
  });

  it("400s on zero segments, more than 6, duplicate names, or a missing offer", async () => {
    expect((await confirm({ segments: [] })).status).toBe(400);
    const seven = Array.from({ length: 7 }, (_, i) => ({ name: `S${i}`, description: `d${i}` }));
    expect((await confirm({ segments: seven })).status).toBe(400);
    expect((await confirm({ segments: [TWO[0], { ...TWO[1], name: TWO[0].name }] })).status).toBe(400);
    const noOffer = await request(app)
      .post("/orgs/audiences/split/confirm")
      .set(getAuthHeaders())
      .send({ brandId: BRAND, segments: TWO });
    expect(noOffer.status).toBe(400);
  });
});
