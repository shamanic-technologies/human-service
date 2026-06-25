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

  it("legacy/neutral audience (no pointer) keeps the dual free dry-run", async () => {
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
      if (u.endsWith("/search/dry-run")) return ok({ totalEntries: 120 });
      if (u.endsWith("/search/count")) return ok({ totalMatched: 45 });
      throw new Error("unexpected url " + u);
    });

    const res = await request(app)
      .post(`/orgs/audiences/${id}/refresh-count`)
      .set(getAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.audience.apolloCount).toBe(120);
    expect(res.body.audience.apifyCount).toBe(45);
  });
});
