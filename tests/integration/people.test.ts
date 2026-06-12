import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { getAuthHeaders } from "../helpers/test-app.js";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

const app = createTestApp();

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

beforeEach(() => {
  fetchSpy.mockReset();
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.APIFY_SERVICE_URL = "http://apify:8080";
  process.env.APIFY_SERVICE_API_KEY = "apify-key";
});

afterEach(() => {
  vi.restoreAllMocks();
});

const APOLLO_PERSON = {
  id: "a1",
  firstName: "Sara",
  lastName: "Freshley",
  name: "Sara Freshley",
  email: "sara@cascobay.com",
  emailStatus: "verified",
  title: "Founder",
  headline: null,
  seniority: "founder",
  linkedinUrl: null,
  photoUrl: null,
  city: null,
  state: null,
  country: null,
  organizationName: "Casco Bay",
  organizationDomain: "cascobay.com",
  organizationWebsiteUrl: null,
  organizationIndustry: "marketing",
  organizationSize: "12",
  organizationLinkedinUrl: null,
  organizationLogoUrl: null,
  organizationCity: null,
  organizationState: null,
  organizationCountry: null,
};

describe("POST /orgs/people/search", () => {
  it("400 without x-org-id", async () => {
    const res = await request(app)
      .post("/orgs/people/search")
      .set({ "X-API-Key": "test-api-key", "Content-Type": "application/json" })
      .send({ provider: "apollo", filters: {} });
    expect(res.status).toBe(400);
  });

  it("400 with x-org-id but no x-user-id (gateway requires both)", async () => {
    const res = await request(app)
      .post("/orgs/people/search")
      .set({
        "X-API-Key": "test-api-key",
        "Content-Type": "application/json",
        "x-org-id": "00000000-0000-0000-0000-000000000001",
      })
      .send({ provider: "apollo", filters: {} });
    expect(res.status).toBe(400);
  });

  it("400 on invalid body (bad provider enum)", async () => {
    const res = await request(app)
      .post("/orgs/people/search")
      .set(getAuthHeaders())
      .send({ provider: "linkedin" });
    expect(res.status).toBe(400);
  });

  it("200 apollo search returns normalized people", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ people: [APOLLO_PERSON], done: false, totalEntries: 42 }));
    const res = await request(app)
      .post("/orgs/people/search")
      .set(getAuthHeaders())
      .send({ provider: "apollo", filters: { titles: ["Founder"] } });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("apollo");
    expect(res.body.total).toBe(42);
    expect(res.body.people[0].email).toBe("sara@cascobay.com");
    expect(res.body.people[0].organization.domain).toBe("cascobay.com");
  });

  it("502 when provider returns 500 (fail loud, no fallback)", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" });
    const res = await request(app)
      .post("/orgs/people/search")
      .set(getAuthHeaders())
      .send({ provider: "apollo", filters: {} });
    expect(res.status).toBe(502);
    expect(res.body.provider).toBe("apollo");
  });
});

describe("POST /orgs/people/resolve-email", () => {
  it("200 default routes to apify /resolve", async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({
        searchId: "s",
        requested: 1,
        resolvedCount: 1,
        leads: [
          {
            firstName: "Jane",
            lastName: "Doe",
            fullName: "Jane Doe",
            title: null,
            seniority: null,
            email: "jane@acme.com",
            emailStatus: "verified",
            source: "pipelinelabs",
            isCatchAll: false,
            isInferred: false,
            linkedinUrl: null,
            city: null,
            state: null,
            country: null,
            companyName: null,
            companyDomain: "acme.com",
            companyIndustry: null,
            companySize: null,
            companyLinkedinUrl: null,
          },
        ],
      })
    );
    const res = await request(app)
      .post("/orgs/people/resolve-email")
      .set(getAuthHeaders())
      .send({ firstName: "Jane", lastName: "Doe", domain: "acme.com" });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("apify");
    expect(res.body.person.email).toBe("jane@acme.com");
    expect(fetchSpy.mock.calls[0][0]).toBe("http://apify:8080/resolve");
  });

  it("400 when firstName missing", async () => {
    const res = await request(app)
      .post("/orgs/people/resolve-email")
      .set(getAuthHeaders())
      .send({ lastName: "Doe", domain: "acme.com" });
    expect(res.status).toBe(400);
  });
});

describe("POST /orgs/people/search/dry-run", () => {
  it("200 apollo returns totalEntries", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ totalEntries: 1234, validationErrors: [] }));
    const res = await request(app)
      .post("/orgs/people/search/dry-run")
      .set(getAuthHeaders())
      .send({ provider: "apollo", filters: { titles: ["CEO"] } });
    expect(res.status).toBe(200);
    expect(res.body.totalEntries).toBe(1234);
  });

  it("501 for provider=apify (unsupported until apify-service#6)", async () => {
    const res = await request(app)
      .post("/orgs/people/search/dry-run")
      .set(getAuthHeaders())
      .send({ provider: "apify", filters: {} });
    expect(res.status).toBe(501);
    expect(res.body.provider).toBe("apify");
    expect(res.body.capability).toBe("dry-run");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET /orgs/people/filters-prompt", () => {
  it("200 apollo proxies prompt", async () => {
    fetchSpy.mockResolvedValueOnce(ok({ prompt: "## filters", schemaVersion: "v1hash" }));
    const res = await request(app)
      .get("/orgs/people/filters-prompt?provider=apollo")
      .set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe("v1hash");
  });

  it("501 for provider=apify", async () => {
    const res = await request(app)
      .get("/orgs/people/filters-prompt?provider=apify")
      .set(getAuthHeaders());
    expect(res.status).toBe(501);
  });
});
