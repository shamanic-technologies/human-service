// An audience belongs to ONE offer (#221), and a suggestion is where audiences
// are actually born — the plain create route has no caller in the fleet. So a
// caller suggesting from an offer-scoped surface must be able to say which offer
// the candidates are for, and the persisted rows must come back from the
// offer-scoped list read. Saying nothing stays brand-wide, exactly as before.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000b1";
const OFFER_1 = "00000000-0000-4000-8000-0000000000c1";
const OFFER_2 = "00000000-0000-4000-8000-0000000000c2";

const fetchSpy = vi.fn();

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

beforeEach(async () => {
  // Stub inside beforeEach, not at describe-body eval — see the test gotcha in
  // CLAUDE.md (one shared global fetch across the whole file).
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

function wire(segments: Array<{ name: string; description: string }>) {
  let seq = 0;
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/complete")) {
      return ok({
        json: { audiences: segments },
        content: "",
        tokensInput: 1,
        tokensOutput: 1,
        model: "gemini-flash",
      });
    }
    if (u.endsWith("/audiences/suggest-from-segment")) {
      const body = JSON.parse(init.body ?? "{}") as { name: string };
      return ok({
        apolloAudienceId: `apollo-aud-${++seq}`,
        filters: { personTitles: [body.name] },
        count: 100,
      });
    }
    throw new Error("unexpected url " + u);
  });
}

function suggest(body: Record<string, unknown>) {
  return request(app)
    .post("/orgs/audiences/suggest")
    .set(getAuthHeaders())
    .send({ brandId: BRAND, ...body });
}

function list(query: string) {
  return request(app).get(`/orgs/audiences${query}`).set(getAuthHeaders());
}

describe("POST /orgs/audiences/suggest — offerId", () => {
  it("persists the offer on every candidate, and the offer-scoped list returns them", async () => {
    wire([
      { name: "US founders", description: "founders in the US" },
      { name: "EU founders", description: "founders in Europe" },
    ]);

    const res = await suggest({ nlPrompt: "founders", offerId: OFFER_1 });
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(2);

    for (const c of res.body.candidates) {
      const [row] = await db
        .select()
        .from(audiences)
        .where(eq(audiences.id, c.audienceId));
      expect(row.offerId).toBe(OFFER_1);
    }

    const scoped = await list(`?offerId=${OFFER_1}`);
    expect(scoped.status).toBe(200);
    expect(
      scoped.body.audiences.map((a: { name: string }) => a.name).sort()
    ).toEqual(["EU founders", "US founders"]);
    expect(
      scoped.body.audiences.every((a: { offerId: string }) => a.offerId === OFFER_1)
    ).toBe(true);
  });

  it("without an offer, stays brand-wide: offer null, absent from an offer-scoped read", async () => {
    wire([{ name: "Brand wide", description: "everyone" }]);

    const res = await suggest({ nlPrompt: "everyone" });
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(audiences)
      .where(eq(audiences.id, res.body.candidates[0].audienceId));
    expect(row.offerId).toBeNull();

    const scoped = await list(`?offerId=${OFFER_1}`);
    expect(scoped.body.audiences).toHaveLength(0);
    // The unfiltered brand read still returns it, unchanged.
    const all = await list(`?brandId=${BRAND}`);
    expect(all.body.audiences.map((a: { name: string }) => a.name)).toEqual([
      "Brand wide",
    ]);
  });

  it("the same name under two offers of one brand yields two distinct audiences", async () => {
    wire([{ name: "US founders", description: "founders in the US" }]);
    const first = await suggest({ nlPrompt: "founders", offerId: OFFER_1 });
    const second = await suggest({ nlPrompt: "founders", offerId: OFFER_2 });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.candidates[0].audienceId).not.toBe(
      first.body.candidates[0].audienceId
    );

    const o1 = await list(`?offerId=${OFFER_1}`);
    const o2 = await list(`?offerId=${OFFER_2}`);
    expect(o1.body.audiences).toHaveLength(1);
    expect(o2.body.audiences).toHaveLength(1);
  });

  it("a re-suggest for the SAME offer refreshes the existing suggested row, not a duplicate", async () => {
    wire([{ name: "US founders", description: "founders in the US" }]);
    const first = await suggest({ nlPrompt: "founders", offerId: OFFER_1 });
    const again = await suggest({ nlPrompt: "founders again", offerId: OFFER_1 });
    expect(again.body.candidates[0].audienceId).toBe(
      first.body.candidates[0].audienceId
    );
    const scoped = await list(`?offerId=${OFFER_1}`);
    expect(scoped.body.audiences).toHaveLength(1);
  });

  it("a brand-wide row is NOT reused by an offer-scoped suggest of the same name", async () => {
    wire([{ name: "US founders", description: "founders in the US" }]);
    const wide = await suggest({ nlPrompt: "founders" });
    const scopedSuggest = await suggest({ nlPrompt: "founders", offerId: OFFER_1 });
    expect(scopedSuggest.body.candidates[0].audienceId).not.toBe(
      wide.body.candidates[0].audienceId
    );
    const scoped = await list(`?offerId=${OFFER_1}`);
    expect(scoped.body.audiences).toHaveLength(1);
    expect(scoped.body.audiences[0].offerId).toBe(OFFER_1);
  });

  it("400s a non-uuid offerId rather than storing junk", async () => {
    wire([{ name: "US founders", description: "founders in the US" }]);
    const res = await suggest({ nlPrompt: "founders", offerId: "offer-1" });
    expect(res.status).toBe(400);
  });
});
