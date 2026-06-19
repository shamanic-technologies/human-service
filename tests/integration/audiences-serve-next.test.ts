import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000b1";

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

// Create an audience with a committed provider + stored filters.
async function createAudience(provider: "apollo" | "apify", name: string) {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({ name, brandId: BRAND, provider, filters: { titles: ["CEO"] } });
  expect(res.status).toBe(201);
  return res.body.audience.id as string;
}

function serveNext(id: string) {
  return request(app).post(`/orgs/audiences/${id}/serve-next`).set(getAuthHeaders());
}

function apifyLead(email: string, linkedin: string) {
  return {
    firstName: "A",
    lastName: "B",
    fullName: "A B",
    title: "CEO",
    seniority: "c_suite",
    email,
    emailStatus: "verified",
    source: "pipelinelabs",
    isCatchAll: false,
    isInferred: false,
    linkedinUrl: linkedin,
    city: null,
    state: null,
    country: null,
    companyName: "Acme",
    companyDomain: "acme.com",
    companyIndustry: null,
    companySize: null,
    companyLinkedinUrl: null,
  };
}

describe("POST /orgs/audiences/:id/serve-next", () => {
  it("apify: first call returns a served person, recorded as an audience member", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/search"))
        return ok({ leads: [apifyLead("a@acme.com", "linkedin.com/in/a")], leadCount: 1, verifiedCount: 1, hasMore: false });
      throw new Error("unexpected url " + url);
    });
    const id = await createAudience("apify", "Apify A");
    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("a@acme.com");

    const members = await request(app).get(`/orgs/audiences/${id}/members`).set(getAuthHeaders());
    expect(members.body.members).toHaveLength(1);
    expect(members.body.members[0].emailNorm).toBe("a@acme.com");
  });

  it("apify: second call pushes the first person's email into the exclude-set, returns a different person", async () => {
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      if (String(url).endsWith("/search")) {
        const body = JSON.parse(init.body ?? "{}") as { excludeEmails?: string[] };
        const excluded = body.excludeEmails ?? [];
        const lead = excluded.includes("a@acme.com")
          ? apifyLead("b@acme.com", "linkedin.com/in/b")
          : apifyLead("a@acme.com", "linkedin.com/in/a");
        return ok({ leads: [lead], leadCount: 1, verifiedCount: 1, hasMore: false });
      }
      throw new Error("unexpected url " + url);
    });
    const id = await createAudience("apify", "Apify B");
    const first = await serveNext(id);
    expect(first.body.person.email).toBe("a@acme.com");
    const second = await serveNext(id);
    expect(second.body.status).toBe("served");
    expect(second.body.person.email).toBe("b@acme.com");
    expect(second.body.person.email).not.toBe(first.body.person.email);
  });

  it("apify: returns a clean exhausted signal when the fresh pool is dry", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/search"))
        return ok({ leads: [], leadCount: 0, verifiedCount: 0, hasMore: false });
      throw new Error("unexpected url " + url);
    });
    const id = await createAudience("apify", "Apify Dry");
    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("exhausted");
    expect(res.body.person).toBeNull();
  });

  it("apollo: enriches a free teaser into a revealed, served person", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/search/next"))
        return ok({ people: [{ id: "p1", firstName: "C", lastName: null, name: null, email: null, emailStatus: null, title: "CEO", headline: null, seniority: "c_suite", linkedinUrl: "linkedin.com/in/p1", photoUrl: null, city: null, state: null, country: null, organizationName: "Acme", organizationDomain: "acme.com", organizationWebsiteUrl: null, organizationIndustry: null, organizationSize: null, organizationLinkedinUrl: null, organizationLogoUrl: null, organizationCity: null, organizationState: null, organizationCountry: null }], done: true, totalEntries: 1 });
      if (u.endsWith("/enrich"))
        return ok({ person: { id: "p1", firstName: "C", lastName: "D", name: "C D", email: "c@acme.com", emailStatus: "verified", title: "CEO", headline: null, seniority: "c_suite", linkedinUrl: "linkedin.com/in/p1", photoUrl: null, city: null, state: null, country: null, organizationName: "Acme", organizationDomain: "acme.com", organizationWebsiteUrl: null, organizationIndustry: null, organizationSize: null, organizationLinkedinUrl: null, organizationLogoUrl: null, organizationCity: null, organizationState: null, organizationCountry: null } });
      throw new Error("unexpected url " + u);
    });
    const id = await createAudience("apollo", "Apollo A");
    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("c@acme.com");
    expect(res.body.person.provider).toBe("apollo");
  });

  it("apollo: second call drops the already-served teaser pre-pay and returns exhausted (no enrich)", async () => {
    let enrichCalls = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/search/next"))
        return ok({ people: [{ id: "p1", firstName: "C", lastName: null, name: null, email: null, emailStatus: null, title: "CEO", headline: null, seniority: "c_suite", linkedinUrl: "linkedin.com/in/p1", photoUrl: null, city: null, state: null, country: null, organizationName: "Acme", organizationDomain: "acme.com", organizationWebsiteUrl: null, organizationIndustry: null, organizationSize: null, organizationLinkedinUrl: null, organizationLogoUrl: null, organizationCity: null, organizationState: null, organizationCountry: null }], done: true, totalEntries: 1 });
      if (u.endsWith("/enrich")) {
        enrichCalls++;
        return ok({ person: { id: "p1", firstName: "C", lastName: "D", name: "C D", email: "c@acme.com", emailStatus: "verified", title: "CEO", headline: null, seniority: "c_suite", linkedinUrl: "linkedin.com/in/p1", photoUrl: null, city: null, state: null, country: null, organizationName: "Acme", organizationDomain: "acme.com", organizationWebsiteUrl: null, organizationIndustry: null, organizationSize: null, organizationLinkedinUrl: null, organizationLogoUrl: null, organizationCity: null, organizationState: null, organizationCountry: null } });
      }
      throw new Error("unexpected url " + u);
    });
    const id = await createAudience("apollo", "Apollo B");
    const first = await serveNext(id);
    expect(first.body.status).toBe("served");
    const second = await serveNext(id);
    expect(second.body.status).toBe("exhausted");
    expect(second.body.person).toBeNull();
    expect(enrichCalls).toBe(1); // never paid to re-enrich the suppressed teaser
  });

  it("422 when the audience has no committed provider", async () => {
    const create = await request(app)
      .post("/orgs/audiences")
      .set(getAuthHeaders())
      .send({ name: "No Provider", brandId: BRAND, filters: { titles: ["CEO"] } });
    const res = await serveNext(create.body.audience.id);
    expect(res.status).toBe(422);
  });

  it("422 when the audience has no stored filters", async () => {
    const create = await request(app)
      .post("/orgs/audiences")
      .set(getAuthHeaders())
      .send({ name: "No Filters", brandId: BRAND, provider: "apify" });
    const res = await serveNext(create.body.audience.id);
    expect(res.status).toBe(422);
  });

  it("404 for an unknown audience id", async () => {
    const res = await serveNext("00000000-0000-4000-8000-0000000000ff");
    expect(res.status).toBe(404);
  });
});
