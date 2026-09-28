import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000d1";

const fetchBefore = globalThis.fetch;
const fetchSpy = vi.fn();

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

const SAMPLE = {
  apolloAudienceId: "apollo-aud-prev",
  count: 270,
  companies: [
    { name: "Experience Travel Group", peopleInSample: 3 },
    { name: "Ampersand Travel", peopleInSample: 1 },
  ],
  people: [
    { firstName: "Melissa", lastNameObfuscated: "Ni***s", title: "Co Founder", company: "Experience Travel Group" },
    { firstName: "James", lastNameObfuscated: "Ja***a", title: "Founder", company: "Ampersand Travel" },
  ],
};

async function createAudience(body: Record<string, unknown>) {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({ brandId: BRAND, ...body });
  expect(res.status).toBe(201);
  return res.body.audience.id as string;
}

beforeEach(async () => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  await cleanTestData();
});

afterAll(async () => {
  globalThis.fetch = fetchBefore;
  await closeDb();
});

describe("GET /orgs/audiences/:id/preview", () => {
  it("returns real companies + people from apollo-service by pointer, no emails", async () => {
    const id = await createAudience({
      name: "UK Asia Tour Operators",
      provider: "apollo",
      apolloAudienceId: "apollo-aud-prev",
      filters: { personTitles: ["Founder"] },
    });
    const urls: string[] = [];
    fetchSpy.mockImplementation(async (url: string) => {
      urls.push(String(url));
      if (String(url).endsWith("/audiences/apollo-aud-prev/preview")) return ok(SAMPLE);
      throw new Error("unexpected url " + url);
    });

    const res = await request(app).get(`/orgs/audiences/${id}/preview`).set(getAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.reason).toBeNull();
    expect(res.body.matchCount).toBe(270);
    expect(res.body.companies).toEqual(SAMPLE.companies);
    expect(res.body.people).toEqual(SAMPLE.people);
    expect(JSON.stringify(res.body)).not.toMatch(/email|phone/i);
    expect(urls).toHaveLength(1);
  });

  it("a second call is served from the row: no second provider call", async () => {
    const id = await createAudience({
      name: "Cached",
      provider: "apollo",
      apolloAudienceId: "apollo-aud-prev",
      filters: { personTitles: ["Founder"] },
    });
    fetchSpy.mockImplementation(async () => ok(SAMPLE));

    const first = await request(app).get(`/orgs/audiences/${id}/preview`).set(getAuthHeaders());
    const second = await request(app).get(`/orgs/audiences/${id}/preview`).set(getAuthHeaders());

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("an audience that matches nobody answers empty with a reason, and stays cached", async () => {
    const id = await createAudience({
      name: "Nobody",
      provider: "apollo",
      apolloAudienceId: "apollo-aud-prev",
      filters: { personTitles: ["Founder"] },
    });
    fetchSpy.mockImplementation(async () => ok({ apolloAudienceId: "apollo-aud-prev", count: 0, companies: [], people: [] }));

    const res = await request(app).get(`/orgs/audiences/${id}/preview`).set(getAuthHeaders());
    await request(app).get(`/orgs/audiences/${id}/preview`).set(getAuthHeaders());

    expect(res.body).toMatchObject({ status: "empty", reason: "no_match", matchCount: 0, companies: [], people: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("an apollo audience with no pointer yet is unavailable (not_built_yet), not cached, no provider call", async () => {
    const id = await createAudience({ name: "Unbuilt", provider: "apollo", filters: { personTitles: ["CEO"] } });

    const res = await request(app).get(`/orgs/audiences/${id}/preview`).set(getAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "unavailable", reason: "not_built_yet", companies: [], people: [], generatedAt: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a non-apollo audience is provider_not_previewable", async () => {
    const id = await createAudience({ name: "Apify one", provider: "apify", filters: { titles: ["CTO"] } });

    const res = await request(app).get(`/orgs/audiences/${id}/preview`).set(getAuthHeaders());

    expect(res.body).toMatchObject({ status: "unavailable", reason: "provider_not_previewable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a provider failure is a 502 and nothing is cached", async () => {
    const id = await createAudience({
      name: "Failing",
      provider: "apollo",
      apolloAudienceId: "apollo-aud-prev",
      filters: { personTitles: ["Founder"] },
    });
    fetchSpy.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }));
    const failed = await request(app).get(`/orgs/audiences/${id}/preview`).set(getAuthHeaders());
    expect(failed.status).toBe(502);

    fetchSpy.mockImplementation(async () => ok(SAMPLE));
    const retried = await request(app).get(`/orgs/audiences/${id}/preview`).set(getAuthHeaders());
    expect(retried.body.status).toBe("ready");
  });

  it("another org's audience is 404 before any provider call", async () => {
    const id = await createAudience({
      name: "Foreign",
      provider: "apollo",
      apolloAudienceId: "apollo-aud-prev",
      filters: { personTitles: ["Founder"] },
    });
    const res = await request(app)
      .get(`/orgs/audiences/${id}/preview`)
      .set({ ...getAuthHeaders(), "x-org-id": "00000000-0000-0000-0000-0000000000ff" });
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
