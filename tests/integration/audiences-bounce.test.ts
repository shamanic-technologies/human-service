import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// The provider's verdict on a revealed email (apollo-service emailVerification)
// is its own suite's concern; here every revealed address reads as deliverable.
vi.mock("../../src/lib/email-verification.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  readEmailVerification: (_p: string, _r: unknown, email: string | null | undefined) =>
    email ? { verdict: "valid", deliverable: true } : null,
}));
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { serveApollo } from "../helpers/serve-apollo.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { isOptOutUrl, optOutResponse, setOptOutEnv } from "../helpers/opt-outs.js";
import { bounceResponse, isBounceUrl } from "../helpers/bounces.js";
import { isWonLeadsUrl, setWonLeadsEnv, wonLeadsResponse } from "../helpers/won-leads.js";
import { db } from "../../src/db/index.js";
import { leadServes, people } from "../../src/db/schema.js";

// An address our own send already bounced must never be served again — for ANY
// org and ANY brand (a bounce is a fact about the address), at the point where
// excluding it still avoids the paid reveal. instantly-service owns the record;
// every test here is about what this gateway does with it (human-service#73).

const app = createTestApp();
const ORG = "00000000-0000-0000-0000-000000000001";
const BRAND_A = "00000000-0000-4000-8000-0000000000b1";
const BRAND_B = "00000000-0000-4000-8000-0000000000b2";

const fetchSpy = vi.fn();
const fetchBeforeThisSuite = globalThis.fetch;

// Fleet-wide bounced addresses for the test in flight.
let bouncedEmails: string[] = [];
// Set to fail the bounce read, to prove the gate refuses rather than serves.
let bounceSourceDown = false;
// Every address set the gateway asked the bounce record about.
let bounceQueries: string[][] = [];

beforeEach(async () => {
  // The brand's won set and the consent log are answered ahead of the spy —
  // empty, so this suite stays about bounces.
  vi.stubGlobal("fetch", async (url: string, init: { body?: string }) => {
    if (isWonLeadsUrl(url)) return ok(wonLeadsResponse(url));
    if (isOptOutUrl(url)) return ok(optOutResponse(url, []));
    if (isBounceUrl(url)) {
      bounceQueries.push(JSON.parse(init?.body ?? "{}").emails ?? []);
      if (bounceSourceDown)
        return { ok: false, status: 503, json: async () => ({}), text: async () => "down" };
      return ok(bounceResponse(init?.body, bouncedEmails));
    }
    return fetchSpy(url, init);
  });
  fetchSpy.mockReset();
  bouncedEmails = [];
  bounceSourceDown = false;
  bounceQueries = [];
  setOptOutEnv();
  setWonLeadsEnv();
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.APIFY_SERVICE_URL = "http://apify:8080";
  process.env.APIFY_SERVICE_API_KEY = "apify-key";
  process.env.CRM_SERVICE_URL = "http://crm:8080";
  process.env.CRM_SERVICE_API_KEY = "crm-key";
  await cleanTestData();
});

afterAll(async () => {
  globalThis.fetch = fetchBeforeThisSuite;
  await closeDb();
});

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

function teaser(id: string) {
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
    linkedinUrl: `https://www.linkedin.com/in/${id}`,
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

function revealed(id: string) {
  return { ...teaser(id), lastName: "D", name: "C D", email: `${id}@acme.com`, emailStatus: "verified" };
}

// Route apollo. `pages` is the teaser stream; every reveal is
// recorded so a test can assert the credit was NOT spent.
function mockApollo(pages: string[][]) {
  const enriched: string[] = [];
  let page = 0;
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/search/next")) {
      const ids = pages[page] ?? [];
      page += 1;
      return ok({ people: ids.map(teaser), done: ids.length === 0, totalEntries: ids.length });
    }
    if (u.endsWith("/enrich")) {
      const id = (JSON.parse(init.body ?? "{}") as { apolloPersonId?: string }).apolloPersonId ?? "";
      enriched.push(id);
      return ok({ person: revealed(id) });
    }
    throw new Error("unexpected url " + u);
  });
  return { enriched };
}

async function createAudience(
  provider: "apollo" | "apify" | "crm",
  name: string,
  brandId: string
) {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({
      name,
      brandId,
      provider,
      ...(provider === "crm" ? {} : { filters: { titles: ["CEO"] } }),
    });
  expect(res.status).toBe(201);
  return res.body.audience.id as string;
}

function serveNext(id: string) {
  return request(app).post(`/orgs/audiences/${id}/serve-next`).set(getAuthHeaders());
}

// ANOTHER org: a bounce recorded while serving them must still exclude the
// person here.
const OTHER_ORG = "00000000-0000-0000-0000-0000000000aa";

// The canonical person row a prior serve would have written — in ANOTHER org by
// default: it is what ties the bounced ADDRESS to the keys a free teaser carries
// (linkedin url, apollo person id), which is how the gate fires before anyone pays.
async function knownPerson(id: string, orgId = OTHER_ORG) {
  await db.insert(people).values({
    orgId,
    emailNorm: `${id}@acme.com`,
    linkedinUrlNorm: `linkedin.com/in/${id}`,
    apolloPersonId: id,
  });
}

describe("a recorded hard bounce on the apollo serve path (candidate API: next → reveal)", () => {
  it("drops the teaser at the FREE stage — the credit is never spent — even when the bounce came from another org", async () => {
    await knownPerson("dead");
    bouncedEmails = ["dead@acme.com"];
    const calls = mockApollo([["dead", "alive"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveApollo(app, id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("alive@acme.com");
    // Nobody paid to reveal an address we already know is dead.
    expect(calls.enriched).toEqual(["alive"]);
  });

  it("resolves the teaser key through an earlier serve's bronze row too", async () => {
    // No canonical `people` row, only the lead_serves row a rejected reveal left.
    await db.insert(leadServes).values({
      orgId: OTHER_ORG,
      brandId: BRAND_B,
      provider: "apollo",
      providerPersonId: "dead",
      email: "Dead@Acme.com",
    });
    bouncedEmails = ["dead@acme.com"];
    const calls = mockApollo([["dead", "alive"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveApollo(app, id);
    expect(res.body.person.email).toBe("alive@acme.com");
    expect(calls.enriched).toEqual(["alive"]);
  });

  it("re-checks at POP time: a teaser buffered before the bounce is dropped before the reveal", async () => {
    const calls = mockApollo([["first", "dead", "alive"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    // Serve 1 buffers the whole page; nobody has bounced yet.
    const r1 = await serveApollo(app, id);
    expect(r1.body.person.email).toBe("first@acme.com");

    // Then our send to "dead" bounces (for another org).
    await knownPerson("dead");
    bouncedEmails = ["dead@acme.com"];

    const r2 = await serveApollo(app, id);
    expect(r2.body.person.email).toBe("alive@acme.com");
    expect(calls.enriched).toEqual(["first", "alive"]);
  });

  it("blocks at FINAL RESOLUTION when no record tied the address to a teaser key, and remembers it", async () => {
    // Nothing ties "ghost" to an address before the reveal, so the block lands
    // after it: the credit is spent, the email is not.
    bouncedEmails = ["ghost@acme.com"];
    const calls = mockApollo([["ghost", "alive"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveApollo(app, id);
    expect(res.status).toBe(200);
    expect(res.body.person.email).toBe("alive@acme.com");
    expect(calls.enriched).toEqual(["ghost", "alive"]);

    // The recorded serve ties the key to the address, so the next request for
    // ANY org drops them on the free teaser instead of paying again.
    const [row] = await db
      .select({ email: leadServes.email })
      .from(leadServes)
      .where(eq(leadServes.providerPersonId, "ghost"));
    expect(row.email).toBe("ghost@acme.com");
  });

  it("asks nothing of the owner when no candidate resolves to a known address", async () => {
    const calls = mockApollo([["alive"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveApollo(app, id);
    expect(res.body.person.email).toBe("alive@acme.com");
    expect(calls.enriched).toEqual(["alive"]);
    // Only the post-reveal check on the address in hand.
    expect(bounceQueries).toEqual([["alive@acme.com"]]);
  });

  it("REFUSES the serve when the bounce record cannot be read", async () => {
    await knownPerson("alive");
    bounceSourceDown = true;
    const calls = mockApollo([["alive"]]);
    const id = await createAudience("apollo", "A", BRAND_A);

    const res = await serveApollo(app, id);
    expect(res.status).toBe(502);
    expect(res.body.source).toBe("instantly-service");
    // A gate that cannot read its own input serves nobody, and pays for nobody.
    expect(calls.enriched).toEqual([]);
  });
});

describe("a recorded hard bounce on the crm serve path", () => {
  it("skips the contact and asks crm-service for the next one", async () => {
    bouncedEmails = ["dead@acme.com"];
    const served: string[] = [];
    let call = 0;
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/serve-next")) {
        const contact =
          call === 0
            ? { id: "c1", primaryEmail: "dead@acme.com", phoneE164: null, fullName: "D", firstName: "D", lastName: null }
            : { id: "c2", primaryEmail: "alive@acme.com", phoneE164: null, fullName: "A", firstName: "A", lastName: null };
        call += 1;
        served.push(contact.primaryEmail);
        return ok({ contacts: [contact], served: 1, exhausted: false });
      }
      throw new Error("unexpected url " + u);
    });
    const id = await createAudience("crm", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.person.email).toBe("alive@acme.com");
    expect(served).toEqual(["dead@acme.com", "alive@acme.com"]);
  });
});

describe("a recorded hard bounce on the apify serve path", () => {
  it("is never handed back even though the actor returned (and billed) them", async () => {
    bouncedEmails = ["dead@acme.com"];
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/search"))
        return ok({
          leads: [
            {
              firstName: "A",
              lastName: "B",
              fullName: "A B",
              title: "CEO",
              seniority: "c_suite",
              email: "dead@acme.com",
              emailStatus: "verified",
              source: "pipelinelabs",
              isCatchAll: false,
              isInferred: false,
              linkedinUrl: "https://linkedin.com/in/dead",
              city: null,
              state: null,
              country: null,
              companyName: "Acme",
              companyDomain: "acme.com",
              companyIndustry: null,
              companySize: null,
              companyLinkedinUrl: null,
            },
          ],
          leadCount: 1,
          verifiedCount: 1,
          hasMore: false,
        });
      throw new Error("unexpected url " + u);
    });
    const id = await createAudience("apify", "A", BRAND_A);

    const res = await serveNext(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("exhausted");
  });
});
