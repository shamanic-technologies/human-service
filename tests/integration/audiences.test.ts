import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { tagAudienceServe, computeStats } from "../../src/services/audiences.js";
import type { ServedContact } from "../../src/services/suppression.js";

const app = createTestApp();

// 4th group starts with 8/9/a/b — Zod 4 .uuid() is variant-strict (see CLAUDE.md).
// org ids ride in headers (lax regex), brand/audience ids ride in bodies (strict).
const ORG_A = "00000000-0000-0000-0000-000000000001"; // matches getAuthHeaders
const ORG_B = "00000000-0000-0000-0000-0000000000bb";
const BRAND_1 = "00000000-0000-4000-8000-0000000000a1";
const BRAND_2 = "00000000-0000-4000-8000-0000000000a2";
const MISSING_AUDIENCE = "00000000-0000-4000-8000-0000000000ff";

function headersForOrg(orgId: string) {
  return { ...getAuthHeaders(), "x-org-id": orgId };
}

function contact(p: Partial<ServedContact>): ServedContact {
  return {
    email: null,
    linkedinUrl: null,
    firstName: null,
    lastName: null,
    companyDomain: null,
    provider: "apollo",
    providerPersonId: null,
    ...p,
  };
}

async function createAudience(
  orgId: string,
  body: Record<string, unknown>
): Promise<string> {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(headersForOrg(orgId))
    .send(body);
  expect(res.status).toBe(201);
  return res.body.audience.id as string;
}

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

describe("Audiences CRUD", () => {
  it("creates an audience with filters, counts null until refreshed", async () => {
    const res = await request(app)
      .post("/orgs/audiences")
      .set(headersForOrg(ORG_A))
      .send({
        name: "Founders SaaS",
        brandId: BRAND_1,
        nlPrompt: "founders at seed-stage SaaS",
        filters: { seniorities: ["founder"], industries: ["software"] },
      });
    expect(res.status).toBe(201);
    expect(res.body.audience.name).toBe("Founders SaaS");
    expect(res.body.audience.brandId).toBe(BRAND_1);
    expect(res.body.audience.filters).toEqual({
      seniorities: ["founder"],
      industries: ["software"],
    });
    expect(res.body.audience.apolloCount).toBeNull();
    expect(res.body.audience.apifyCount).toBeNull();
    expect(res.body.audience.countedAt).toBeNull();
    expect(res.body.audience.createdByUserId).toBe(
      "00000000-0000-0000-0000-000000000002"
    );
  });

  it("stores caller-provided count snapshot + stamps countedAt", async () => {
    const res = await request(app)
      .post("/orgs/audiences")
      .set(headersForOrg(ORG_A))
      .send({ name: "A", brandId: BRAND_1, apolloCount: 120, apifyCount: 45 });
    expect(res.status).toBe(201);
    expect(res.body.audience.apolloCount).toBe(120);
    expect(res.body.audience.apifyCount).toBe(45);
    expect(res.body.audience.countedAt).not.toBeNull();
  });

  it("rejects create without brandId (400)", async () => {
    const res = await request(app)
      .post("/orgs/audiences")
      .set(headersForOrg(ORG_A))
      .send({ name: "no brand" });
    expect(res.status).toBe(400);
  });

  it("gets / lists / filters by brand", async () => {
    const id1 = await createAudience(ORG_A, { name: "B1", brandId: BRAND_1 });
    await createAudience(ORG_A, { name: "B2", brandId: BRAND_2 });

    const get = await request(app)
      .get(`/orgs/audiences/${id1}`)
      .set(headersForOrg(ORG_A));
    expect(get.status).toBe(200);
    expect(get.body.audience.name).toBe("B1");

    const list = await request(app)
      .get("/orgs/audiences")
      .set(headersForOrg(ORG_A));
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);

    const filtered = await request(app)
      .get(`/orgs/audiences?brandId=${BRAND_2}`)
      .set(headersForOrg(ORG_A));
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.audiences[0].name).toBe("B2");
  });

  it("patches name + filters", async () => {
    const id = await createAudience(ORG_A, { name: "old", brandId: BRAND_1 });
    const res = await request(app)
      .patch(`/orgs/audiences/${id}`)
      .set(headersForOrg(ORG_A))
      .send({ name: "new", filters: { titles: ["CTO"] } });
    expect(res.status).toBe(200);
    expect(res.body.audience.name).toBe("new");
    expect(res.body.audience.filters).toEqual({ titles: ["CTO"] });
  });

  it("deletes (204) then 404 on get", async () => {
    const id = await createAudience(ORG_A, { name: "del", brandId: BRAND_1 });
    const del = await request(app)
      .delete(`/orgs/audiences/${id}`)
      .set(headersForOrg(ORG_A));
    expect(del.status).toBe(204);
    const get = await request(app)
      .get(`/orgs/audiences/${id}`)
      .set(headersForOrg(ORG_A));
    expect(get.status).toBe(404);
  });

  it("org isolation: org B sees 404 for org A's audience (get/patch/delete)", async () => {
    const id = await createAudience(ORG_A, { name: "secret", brandId: BRAND_1 });
    expect(
      (await request(app).get(`/orgs/audiences/${id}`).set(headersForOrg(ORG_B)))
        .status
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/orgs/audiences/${id}`)
          .set(headersForOrg(ORG_B))
          .send({ name: "hijack" })
      ).status
    ).toBe(404);
    expect(
      (
        await request(app)
          .delete(`/orgs/audiences/${id}`)
          .set(headersForOrg(ORG_B))
      ).status
    ).toBe(404);
  });
});

describe("Audience membership engine (dedup + provenance)", () => {
  it("tags a served contact into one canonical person + one member row", async () => {
    const id = await createAudience(ORG_A, { name: "M", brandId: BRAND_1 });
    await tagAudienceServe(ORG_A, id, [
      contact({
        email: "Jane@Acme.com",
        firstName: "Jane",
        lastName: "Doe",
        provider: "apify",
        companyDomain: "acme.com",
      }),
    ]);

    const members = await request(app)
      .get(`/orgs/audiences/${id}/members`)
      .set(headersForOrg(ORG_A));
    expect(members.status).toBe(200);
    expect(members.body.total).toBe(1);
    expect(members.body.members[0].emailNorm).toBe("jane@acme.com");
    expect(members.body.members[0].fullName).toBe("Jane Doe");
    expect(members.body.members[0].source).toBe("apify");
    expect(members.body.members[0].confidence).toBe("provider_confirmed");
  });

  it("dedups the same person across providers (linkedin match, apollo teaser then apify reveal)", async () => {
    const id = await createAudience(ORG_A, { name: "D", brandId: BRAND_1 });
    // apollo teaser: no email, has linkedin + apollo person id.
    await tagAudienceServe(ORG_A, id, [
      contact({
        linkedinUrl: "https://www.linkedin.com/in/janedoe/",
        firstName: "Jane",
        provider: "apollo",
        providerPersonId: "apollo-1",
      }),
    ]);
    // apify reveal of the same person: same linkedin, now with email.
    await tagAudienceServe(ORG_A, id, [
      contact({
        email: "jane@acme.com",
        linkedinUrl: "https://linkedin.com/in/janedoe",
        firstName: "Jane",
        lastName: "Doe",
        provider: "apify",
      }),
    ]);

    const members = await request(app)
      .get(`/orgs/audiences/${id}/members`)
      .set(headersForOrg(ORG_A));
    expect(members.body.total).toBe(1); // ONE canonical person
    const m = members.body.members[0];
    expect(m.emailNorm).toBe("jane@acme.com"); // email learned on reveal
    expect(m.lastName).toBe("Doe"); // last name learned on reveal
  });

  it("one person joins many audiences (provenance), idempotent re-serve", async () => {
    const a1 = await createAudience(ORG_A, { name: "A1", brandId: BRAND_1 });
    const a2 = await createAudience(ORG_A, { name: "A2", brandId: BRAND_2 });
    const c = contact({ email: "multi@x.com", firstName: "Multi", provider: "apollo" });

    await tagAudienceServe(ORG_A, a1, [c]);
    await tagAudienceServe(ORG_A, a2, [c]);
    await tagAudienceServe(ORG_A, a1, [c]); // re-serve — idempotent

    const m1 = await request(app)
      .get(`/orgs/audiences/${a1}/members`)
      .set(headersForOrg(ORG_A));
    const m2 = await request(app)
      .get(`/orgs/audiences/${a2}/members`)
      .set(headersForOrg(ORG_A));
    expect(m1.body.total).toBe(1);
    expect(m2.body.total).toBe(1);

    // stats by email returns BOTH audiences for the one person.
    const stats = await computeStats(ORG_A, { emails: ["multi@x.com"] });
    expect(stats.matched).toHaveLength(1);
    expect(stats.matched[0].audiences.map((a) => a.audienceId).sort()).toEqual(
      [a1, a2].sort()
    );
    expect(stats.byAudience).toHaveLength(2);
    expect(stats.byAudience.every((a) => a.matchedCount === 1)).toBe(true);
  });

  it("stats: matches by personId, reports unmatched", async () => {
    const id = await createAudience(ORG_A, { name: "S", brandId: BRAND_1 });
    await tagAudienceServe(ORG_A, id, [
      contact({ email: "known@x.com", provider: "apollo" }),
    ]);
    const byEmail = await computeStats(ORG_A, {
      emails: ["known@x.com", "ghost@x.com"],
    });
    expect(byEmail.matched).toHaveLength(1);
    expect(byEmail.unmatched.emails).toEqual(["ghost@x.com"]);

    const personId = byEmail.matched[0].personId;
    const byId = await computeStats(ORG_A, { personIds: [personId] });
    expect(byId.matched).toHaveLength(1);
    expect(byId.matched[0].emailNorm).toBe("known@x.com");
  });

  it("stats are org-scoped: org B does not see org A's people", async () => {
    const id = await createAudience(ORG_A, { name: "P", brandId: BRAND_1 });
    await tagAudienceServe(ORG_A, id, [
      contact({ email: "a-only@x.com", provider: "apollo" }),
    ]);
    const stats = await computeStats(ORG_B, { emails: ["a-only@x.com"] });
    expect(stats.matched).toHaveLength(0);
    expect(stats.unmatched.emails).toEqual(["a-only@x.com"]);
  });

  it("400 stats with neither emails nor personIds", async () => {
    const res = await request(app)
      .post("/orgs/audiences/stats")
      .set(headersForOrg(ORG_A))
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("People route audience tagging", () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  beforeEach(() => {
    fetchSpy.mockReset();
    process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
    process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
    process.env.APIFY_SERVICE_URL = "http://apify:8080";
    process.env.APIFY_SERVICE_API_KEY = "apify-key";
  });

  it("resolve-email with audienceId tags the resolved person as a member", async () => {
    const id = await createAudience(ORG_A, { name: "R", brandId: BRAND_1 });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
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
      }),
      text: async () => "",
    });

    const res = await request(app)
      .post("/orgs/people/resolve-email")
      .set(headersForOrg(ORG_A))
      .send({
        provider: "apify",
        firstName: "Jane",
        lastName: "Doe",
        domain: "acme.com",
        audienceId: id,
      });
    expect(res.status).toBe(200);
    expect(res.body.person.email).toBe("jane@acme.com");

    const members = await request(app)
      .get(`/orgs/audiences/${id}/members`)
      .set(headersForOrg(ORG_A));
    expect(members.body.total).toBe(1);
    expect(members.body.members[0].emailNorm).toBe("jane@acme.com");
  });

  it("search with unknown audienceId → 404 before any provider call", async () => {
    const res = await request(app)
      .post("/orgs/people/search")
      .set(headersForOrg(ORG_A))
      .send({
        provider: "apollo",
        filters: { titles: ["CEO"] },
        audienceId: MISSING_AUDIENCE,
      });
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolve-email with unknown audienceId → 404 before any provider call", async () => {
    const res = await request(app)
      .post("/orgs/people/resolve-email")
      .set(headersForOrg(ORG_A))
      .send({
        providerPersonId: "x",
        audienceId: MISSING_AUDIENCE,
      });
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
