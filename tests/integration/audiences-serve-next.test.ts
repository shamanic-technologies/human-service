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

// A masked apollo free teaser (search/next page item): person id + first name +
// linkedin, NO email/last-name/domain (apollo masks those until enrich).
function apolloTeaser(id: string, linkedin: string) {
  return {
    id,
    firstName: "C",
    lastName: null,
    name: null,
    email: null,
    emailStatus: null,
    title: "CEO",
    headline: null,
    seniority: "c_suite",
    linkedinUrl: linkedin,
    photoUrl: null,
    city: null,
    state: null,
    country: null,
    organizationName: "Acme",
    organizationDomain: "acme.com",
    organizationWebsiteUrl: null,
    organizationIndustry: null,
    organizationSize: null,
    organizationLinkedinUrl: null,
    organizationLogoUrl: null,
    organizationCity: null,
    organizationState: null,
    organizationCountry: null,
  };
}

// The enriched (revealed) apollo person returned by /enrich for a given id.
function apolloRevealed(id: string, email: string, linkedin: string) {
  return {
    ...apolloTeaser(id, linkedin),
    lastName: "D",
    name: "C D",
    email,
    emailStatus: "verified",
  };
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

  it("apollo LEGACY (no apollo_audience_id): remaps the stored NEUTRAL filters to apollo params (not forwarded verbatim)", async () => {
    // A pre-Wave-2 apollo audience holds the old NEUTRAL blob ({titles:[...]}) and
    // has no pointer. serve-next MUST remap it via toApolloSearchParams (so apollo
    // gets personTitles), NOT forward the neutral keys verbatim — else apollo sees
    // an unknown `titles` field and the audience serves unfiltered/empty. Guards
    // the migration window before the backfill assigns pointers.
    let searchBody: Record<string, unknown> | null = null;
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/search/next")) {
        searchBody = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        return ok({ people: [{ id: "p1", firstName: "C", lastName: null, name: null, email: null, emailStatus: null, title: "CEO", headline: null, seniority: "c_suite", linkedinUrl: "linkedin.com/in/p1", photoUrl: null, city: null, state: null, country: null, organizationName: "Acme", organizationDomain: "acme.com", organizationWebsiteUrl: null, organizationIndustry: null, organizationSize: null, organizationLinkedinUrl: null, organizationLogoUrl: null, organizationCity: null, organizationState: null, organizationCountry: null }], done: true, totalEntries: 1 });
      }
      if (u.endsWith("/enrich"))
        return ok({ person: { id: "p1", firstName: "C", lastName: "D", name: "C D", email: "c@acme.com", emailStatus: "verified", title: "CEO", headline: null, seniority: "c_suite", linkedinUrl: "linkedin.com/in/p1", photoUrl: null, city: null, state: null, country: null, organizationName: "Acme", organizationDomain: "acme.com", organizationWebsiteUrl: null, organizationIndustry: null, organizationSize: null, organizationLinkedinUrl: null, organizationLogoUrl: null, organizationCity: null, organizationState: null, organizationCountry: null } });
      throw new Error("unexpected url " + u);
    });
    const id = await createAudience("apollo", "Legacy Apollo");
    const res = await serveNext(id);
    expect(res.body.status).toBe("served");
    // Remapped: neutral `titles` → apollo `personTitles`; no raw `titles` key leaks.
    const sp = (searchBody as unknown as { searchParams?: Record<string, unknown> })?.searchParams ?? {};
    expect(sp.personTitles).toEqual(["CEO"]);
    expect(sp.titles).toBeUndefined();
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

  it("apollo: drains a full teaser page across calls — serves every teaser, advancing apollo's cursor only ONCE per page", async () => {
    // THE FIX. One /search/next page of 3 teasers must serve 3 people over 3
    // calls, hitting /search/next exactly twice (once to fill the buffer, once to
    // confirm exhaustion) — NOT 3 times (which discarded ~99/page and capped the
    // audience at ~1% of its pool). enrich is one-at-a-time, once per teaser.
    let searchNextCalls = 0;
    let enrichCalls = 0;
    const emailById: Record<string, string> = {
      p1: "p1@acme.com",
      p2: "p2@acme.com",
      p3: "p3@acme.com",
    };
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/search/next")) {
        searchNextCalls++;
        // First page: the 3 teasers. Every later page: empty + done (the cursor
        // is past totalPages — true pool exhaustion).
        return searchNextCalls === 1
          ? ok({
              people: [
                apolloTeaser("p1", "linkedin.com/in/p1"),
                apolloTeaser("p2", "linkedin.com/in/p2"),
                apolloTeaser("p3", "linkedin.com/in/p3"),
              ],
              done: false,
              totalEntries: 3,
            })
          : ok({ people: [], done: true, totalEntries: 3 });
      }
      if (u.endsWith("/enrich")) {
        enrichCalls++;
        const id = (JSON.parse(init.body ?? "{}") as { apolloPersonId: string })
          .apolloPersonId;
        return ok({ person: apolloRevealed(id, emailById[id], `linkedin.com/in/${id}`) });
      }
      throw new Error("unexpected url " + u);
    });

    const id = await createAudience("apollo", "Apollo Drain");
    const served: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await serveNext(id);
      expect(res.body.status).toBe("served");
      served.push(res.body.person.email);
    }
    // 4th call: buffer empty → one more /search/next → empty+done → exhausted.
    const last = await serveNext(id);
    expect(last.body.status).toBe("exhausted");
    expect(last.body.person).toBeNull();

    // All 3 distinct teasers served from a SINGLE fetched page.
    expect(new Set(served)).toEqual(
      new Set(["p1@acme.com", "p2@acme.com", "p3@acme.com"])
    );
    expect(enrichCalls).toBe(3); // one billed reveal per served teaser
    expect(searchNextCalls).toBe(2); // page-fill + exhaustion-confirm — NOT 3+

    const members = await request(app)
      .get(`/orgs/audiences/${id}/members`)
      .set(getAuthHeaders());
    expect(members.body.members).toHaveLength(3);
  });

  it("apollo: a buffered teaser suppressed after buffering is dropped AT POP (pre-pay), not re-enriched", async () => {
    // Two teasers buffered together share a linkedin url (same person, two apollo
    // ids — a real dedup case). Serving the first suppresses that linkedin; the
    // second is caught by the pop-time suppression re-check (it was fresh when
    // buffered, suppressed by the time it is popped) and dropped WITHOUT a paid
    // enrich. Proves no re-serve / no over-spend across the buffer boundary.
    let searchNextCalls = 0;
    let enrichCalls = 0;
    const SHARED = "linkedin.com/in/shared";
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/search/next")) {
        searchNextCalls++;
        return searchNextCalls === 1
          ? ok({
              people: [apolloTeaser("p1", SHARED), apolloTeaser("p2", SHARED)],
              done: false,
              totalEntries: 2,
            })
          : ok({ people: [], done: true, totalEntries: 2 });
      }
      if (u.endsWith("/enrich")) {
        enrichCalls++;
        const id = (JSON.parse(init.body ?? "{}") as { apolloPersonId: string })
          .apolloPersonId;
        return ok({ person: apolloRevealed(id, `${id}@acme.com`, SHARED) });
      }
      throw new Error("unexpected url " + u);
    });

    const id = await createAudience("apollo", "Apollo Pop Suppress");
    const first = await serveNext(id);
    expect(first.body.status).toBe("served");
    const second = await serveNext(id);
    expect(second.body.status).toBe("exhausted");
    expect(second.body.person).toBeNull();
    // Only ONE teaser was ever enriched; the linkedin-twin was dropped at pop.
    expect(enrichCalls).toBe(1);
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
