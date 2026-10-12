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
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.APIFY_SERVICE_URL = "http://apify:8080";
  process.env.APIFY_SERVICE_API_KEY = "apify-key";
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

describe("POST /orgs/audiences/:id/refresh-count", () => {
  it("apollo audience with a pointer re-counts via apollo-service /audiences/{id}/dry-run (by pointer)", async () => {
    const create = await request(app)
      .post("/orgs/audiences")
      .set(getAuthHeaders())
      .send({
        name: "Pointer Audience",
        brandId: BRAND,
        provider: "apollo",
        apolloAudienceId: "apollo-aud-99",
        filters: { personTitles: ["CEO"] },
      });
    expect(create.status).toBe(201);
    const id = create.body.audience.id;

    let dryRunUrl = "";
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/audiences/apollo-aud-99/dry-run")) {
        dryRunUrl = u;
        return ok({ count: 7777 });
      }
      throw new Error("unexpected url " + u);
    });

    const res = await request(app)
      .post(`/orgs/audiences/${id}/refresh-count`)
      .set(getAuthHeaders());

    expect(res.status).toBe(200);
    // Counted by POINTER — apollo-service owns the faithful filters.
    expect(dryRunUrl).toContain("/audiences/apollo-aud-99/dry-run");
    expect(res.body.audience.apolloCount).toBe(7777);
  });

  it("apify audience counts on apify only; the apollo snapshot is left as stored", async () => {
    const create = await request(app)
      .post("/orgs/audiences")
      .set(getAuthHeaders())
      .send({
        name: "Neutral Audience",
        brandId: BRAND,
        provider: "apify",
        filters: { titles: ["CTO"] },
      });
    expect(create.status).toBe(201);
    const id = create.body.audience.id;

    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/search/count")) return ok({ totalMatched: 45 });
      throw new Error("unexpected url " + u);
    });

    const res = await request(app)
      .post(`/orgs/audiences/${id}/refresh-count`)
      .set(getAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.audience.apolloCount).toBeNull();
    expect(res.body.audience.apifyCount).toBe(45);
  });

  it("apollo audience written with native filters and no pointer: born counted, refresh never touches apify", async () => {
    const native = {
      person_titles: ["CTO"],
      organization_locations: ["United States"],
      buying_signal: { type: "hiring", window_days: 30, job_titles: ["QA Engineer"] },
    };
    const bodies: unknown[] = [];
    fetchSpy.mockImplementation(async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (u === "http://apollo:8080/search/dry-run") {
        bodies.push(JSON.parse(init?.body ?? "null"));
        return ok({ totalEntries: bodies.length === 1 ? 310 : 325 });
      }
      throw new Error("unexpected url " + u);
    });
    // Apify is not configured in prod: an apollo audience must not need it.
    delete process.env.APIFY_SERVICE_URL;
    delete process.env.APIFY_SERVICE_API_KEY;

    const create = await request(app)
      .post("/orgs/audiences")
      .set(getAuthHeaders())
      .send({ name: "Hiring QA", brandId: BRAND, provider: "apollo", filters: native });
    expect(create.status).toBe(201);
    expect(create.body.audience.apolloCount).toBe(310);
    expect(create.body.audience.countedAt).not.toBeNull();

    const res = await request(app)
      .post(`/orgs/audiences/${create.body.audience.id}/refresh-count`)
      .set(getAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.audience.apolloCount).toBe(325);
    // The native filters are sent verbatim, never remapped as neutral ones.
    expect(bodies).toEqual([native, native]);
  });

  it("apollo create whose native filters apollo-service refuses is a 400, nothing written", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u === "http://apollo:8080/search/dry-run") {
        return { ok: false, status: 400, json: async () => ({}), text: async () => "bad filter" };
      }
      throw new Error("unexpected url " + u);
    });
    const create = await request(app)
      .post("/orgs/audiences")
      .set(getAuthHeaders())
      .send({ name: "Bad", brandId: BRAND, provider: "apollo", filters: { nope: 1 } });
    expect(create.status).toBe(400);
    const list = await request(app).get(`/orgs/audiences?brandId=${BRAND}`).set(getAuthHeaders());
    expect(list.body.audiences).toHaveLength(0);
  });
});
