// The new-campaign modal's split: a confirmed target text -> up to 6
// non-overlapping segments (name, sentence, icon), then the kept ones become
// ACTIVE audiences under the brand + offer. Proposing makes NO provider call and
// persists nothing; confirming writes the rows and immediately builds each
// one's Apollo filters in the background (provider apollo).
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import {
  AudienceTargetOfferNotFoundError,
  draftAudienceTarget,
} from "../../src/services/audience-target.js";

// The draft itself (offer read + LLM) is pinned in
// tests/unit/audience-target.test.ts; here it answers a fixed person-level target.
const DRAFTED =
  "Founders and CEOs of B2B SaaS companies in the US and Europe, plus their assistants and chiefs of staff. Not HR, legal or recruiting.";
vi.mock("../../src/services/audience-target.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-target.js")>()),
  draftAudienceTarget: vi.fn(),
}));

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
  vi.mocked(draftAudienceTarget).mockReset();
  vi.mocked(draftAudienceTarget).mockResolvedValue(DRAFTED);
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
      { ...TWO[0], icon: "globe-hemisphere-west", iconConfidence: 0.9, estimatedLeadCount: null },
      { ...TWO[1], icon: "globe-hemisphere-east", iconConfidence: 0.9, estimatedLeadCount: null },
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

  it("carries each segment's size guess from the SAME completion, null (never 0) when unusable", async () => {
    wire({
      axes: ["geography"],
      segments: [
        { ...TWO[0], estimatedLeadCount: 14200.4 },
        { ...TWO[1], estimatedLeadCount: 0 },
        { name: "Asia SaaS founders", description: "Founders of B2B SaaS companies based in Asia.", estimatedLeadCount: "lots" },
      ] as unknown as Array<{ name: string; description: string }>,
    });
    const res = await propose("B2B SaaS founders in the US, Europe and Asia");
    expect(res.status).toBe(200);
    expect(res.body.segments.map((s: { estimatedLeadCount: unknown }) => s.estimatedLeadCount)).toEqual([
      14200,
      null,
      null,
    ]);
    // No added call: still one completion + one judgment, and the icon judge
    // never sees the size guess.
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(["http://chat:8080/complete", "http://chat:8080/orgs/judgments"]);
    const judgment = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(JSON.stringify(judgment.state)).not.toContain("estimatedLeadCount");
    const completion = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(completion.responseSchema.properties.segments.items.required).toContain("estimatedLeadCount");
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
        nlPrompt: DRAFTED,
        source: "split_proposal",
      });
    }
    // The person-level target is drafted from the customer's words against THIS offer.
    expect(vi.mocked(draftAudienceTarget)).toHaveBeenCalledWith(
      expect.objectContaining({
        customerTarget: "B2B SaaS founders in the US and Europe",
        brandId: BRAND,
        offerId: OFFER,
      })
    );
    const listed = await request(app)
      .get(`/orgs/audiences?offerId=${OFFER}&status=active`)
      .set(getAuthHeaders());
    expect(listed.body.audiences.map((a: { name: string }) => a.name).sort()).toEqual(
      TWO.map((s) => s.name).sort()
    );
  });

  it("builds every confirmed segment's Apollo filters right away, so none stays active and unservable", async () => {
    process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
    process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
    const built: string[] = [];
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      if (String(url).endsWith("/audiences/suggest-from-segment")) {
        const body = JSON.parse(init.body ?? "{}") as { name: string; description: string };
        built.push(body.name);
        return ok({
          apolloAudienceId: `ptr-${body.name}`,
          filters: { person_titles: [body.name] },
          count: 100 + built.length,
        });
      }
      throw new Error("unexpected url " + String(url));
    });
    const res = await confirm({ segments: TWO });
    expect(res.status).toBe(201);

    let rows: Array<typeof audiences.$inferSelect> = [];
    for (let i = 0; i < 50; i++) {
      rows = await db.select().from(audiences);
      if (rows.every((r) => r.apolloAudienceId && r.filters)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(built.sort()).toEqual(TWO.map((s) => s.name).sort());
    for (const r of rows) {
      expect(r.status).toBe("active");
      expect(r.apolloAudienceId).toBe(`ptr-${r.name}`);
      expect(r.filters).toEqual({ person_titles: [r.name] });
      expect(r.apolloCount).toBeGreaterThan(100);
    }
  });

  it("gives every confirmed profile its avatar right away, org-billed with the confirm's identity", async () => {
    const imageCalls: Array<Record<string, string>> = [];
    fetchSpy.mockImplementation(async (url: string, init: { headers?: Record<string, string> }) => {
      if (String(url).endsWith("/orgs/images/generate")) {
        imageCalls.push(init.headers ?? {});
        return ok({ url: `https://cdn.test/${imageCalls.length}.png`, mimeType: "image/png" });
      }
      // Pointer build / target text are not under test here.
      return { ok: false, status: 503, json: async () => ({}), text: async () => "not under test" };
    });
    const res = await confirm({ segments: TWO });
    expect(res.status).toBe(201);

    let rows: Array<typeof audiences.$inferSelect> = [];
    for (let i = 0; i < 50; i++) {
      rows = await db.select().from(audiences);
      if (rows.every((r) => r.avatarUrl)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.avatarUrl).toMatch(/^https:\/\/cdn\.test\/\d\.png$/);
    expect(imageCalls).toHaveLength(2);
    for (const h of imageCalls) expect(h["x-org-id"]).toBe(getAuthHeaders()["x-org-id"]);
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

describe("POST /orgs/audiences/split/confirm — target draft failure", () => {
  it("writes nothing and answers 502 when the offer's target cannot be drafted", async () => {
    vi.mocked(draftAudienceTarget).mockRejectedValueOnce(
      new AudienceTargetOfferNotFoundError(BRAND, OFFER)
    );
    const res = await confirm({ targetAudience: "B2B SaaS founders", segments: TWO });
    expect(res.status).toBe(502);
    expect(await db.select().from(audiences)).toHaveLength(0);
  });
});
