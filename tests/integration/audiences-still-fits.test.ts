import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { tagAudienceServe } from "../../src/services/audiences.js";
import type { ServedContact } from "../../src/services/suppression.js";
import { db } from "../../src/db/index.js";
import { audiences, audienceScreenedOut, leadServes, brandSuppressions, audienceMembers, audienceCandidates, people, googleMapsBrandClaims } from "../../src/db/schema.js";
import { and, eq } from "drizzle-orm";

// POST /internal/audiences/still-fits (STILL-FITS-1012): does this person STILL
// belong to this audience, right now? CRM audiences ask crm-service; search
// audiences answer from membership + screen verdicts. Never a serve.

const app = createTestApp();
const fetchBefore = globalThis.fetch;

const ORG = "00000000-0000-0000-0000-0000000000f1";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000f2";
const BRAND = "00000000-0000-4000-8000-0000000000f3";
const CRM_PEOPLE = "00000000-0000-4000-8000-0000000000f4";
const CRM_FILE = "00000000-0000-4000-8000-0000000000f5";
const APOLLO = "00000000-0000-4000-8000-0000000000f6";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";
const UPLOAD = "00000000-0000-4000-8000-0000000000f7";
const FILTER = { signedUp: true, replied: false, reachableBy: "phone" as const };

const crmCalls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
let crmAnswer: (body: Record<string, unknown>) => { status: number; body: unknown };

function ask(body: Record<string, unknown>) {
  return request(app)
    .post("/internal/audiences/still-fits")
    .set({ "X-API-Key": "test-api-key", "Content-Type": "application/json" })
    .send(body);
}

function contact(p: Partial<ServedContact>): ServedContact {
  return { email: null, linkedinUrl: null, firstName: null, lastName: null, companyDomain: null, provider: "apollo", providerPersonId: null, ...p };
}

beforeEach(async () => {
  await cleanTestData();
  process.env.CRM_SERVICE_URL = "http://crm.test";
  process.env.CRM_SERVICE_API_KEY = "crm-key";
  crmCalls.length = 0;
  crmAnswer = () => ({ status: 200, body: { fits: true, pool: "people" } });
  vi.stubGlobal("fetch", async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
    if (String(url).startsWith("http://crm.test/orgs/contacts/still-fits")) {
      const body = JSON.parse(init.body ?? "{}");
      crmCalls.push({ url: String(url), body, headers: init.headers ?? {} });
      const a = crmAnswer(body);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  await db.insert(audiences).values([
    { id: CRM_PEOPLE, orgId: ORG, brandId: BRAND, name: "Signups who never answered", provider: "crm", status: "active", crmPeopleFilter: FILTER },
    { id: CRM_FILE, orgId: ORG, brandId: BRAND, name: "Imported list", provider: "crm", status: "active", crmUploadId: UPLOAD },
    { id: APOLLO, orgId: ORG, brandId: BRAND, name: "Founders", provider: "apollo", status: "active" },
  ] as never);
});

afterAll(async () => {
  globalThis.fetch = fetchBefore;
  await closeDb();
});

describe("POST /internal/audiences/still-fits", () => {
  it("CRM people pool: asks crm-service with the audience's stored filter, verbatim", async () => {
    const r = await ask({ orgId: ORG, audienceId: CRM_PEOPLE, brandId: BRAND, email: "quiet@x.test", personId: null });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ fits: true, basis: "crm_people_pool" });
    expect(crmCalls).toHaveLength(1);
    expect(crmCalls[0].body).toEqual({ brandId: BRAND, email: "quiet@x.test", people: FILTER });
    expect(crmCalls[0].headers["x-org-id"]).toBe(ORG);
  });

  it("CRM people pool: a person who wrote on WhatsApp no longer fits, with crm-service's words", async () => {
    crmAnswer = () => ({
      status: 200,
      body: { fits: false, pool: "people", reason: "Has written to the brand on WhatsApp", failed: [{ code: "replied", reason: "Has written to the brand on WhatsApp" }] },
    });
    const r = await ask({ orgId: ORG, audienceId: CRM_PEOPLE, brandId: BRAND, email: "andrew@x.test" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      fits: false,
      basis: "crm_people_pool",
      reason: "Has written to the brand on WhatsApp",
      failed: [{ code: "replied", reason: "Has written to the brand on WhatsApp" }],
    });
  });

  it("CRM file: bound to its upload", async () => {
    const r = await ask({ orgId: ORG, audienceId: CRM_FILE, brandId: BRAND, email: "a@x.test" });
    expect(r.body).toEqual({ fits: true, basis: "crm_list" });
    expect(crmCalls[0].body).toEqual({ brandId: BRAND, email: "a@x.test", uploadIds: [UPLOAD] });
  });

  it("CRM: the pipe's step filter is forwarded verbatim beside the pool filter", async () => {
    const step = { reached: ["form_submission"], notReached: ["sale"] };
    const r = await ask({ orgId: ORG, audienceId: CRM_PEOPLE, brandId: BRAND, email: "warm@x.test", stepFilter: step });
    expect(r.status).toBe(200);
    expect(crmCalls[0].body).toEqual({ brandId: BRAND, email: "warm@x.test", people: FILTER, stepFilter: step });
  });

  it("CRM: crm-service refusing the step filter is a 400", async () => {
    crmAnswer = () => ({ status: 400, body: { error: "unknown step" } });
    const r = await ask({ orgId: ORG, audienceId: CRM_FILE, brandId: BRAND, email: "a@x.test", stepFilter: { reached: ["x"] } });
    expect(r.status).toBe(400);
    expect(r.body.source).toBe("crm-service");
  });

  it("search audience + step filter = 422 step_filter_needs_crm, never fits", async () => {
    await tagAudienceServe(ORG, APOLLO, [contact({ email: "founder@acme.test", providerPersonId: "ap-1" })]);
    const r = await ask({ orgId: ORG, audienceId: APOLLO, brandId: BRAND, email: "founder@acme.test", stepFilter: { reached: ["signup"] } });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("step_filter_needs_crm");
    expect(crmCalls).toHaveLength(0);
  });

  it("CRM: nobody at the address = 422, never fits", async () => {
    crmAnswer = () => ({ status: 404, body: { type: "person_not_found" } });
    const r = await ask({ orgId: ORG, audienceId: CRM_PEOPLE, brandId: BRAND, email: "ghost@x.test" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("person_unknown_to_crm");
  });

  it("CRM: crm-service down = 502", async () => {
    crmAnswer = () => ({ status: 500, body: { error: "boom" } });
    const r = await ask({ orgId: ORG, audienceId: CRM_PEOPLE, brandId: BRAND, email: "a@x.test" });
    expect(r.status).toBe(502);
  });

  it("CRM: a reply without a verdict is a 502, never fits", async () => {
    crmAnswer = () => ({ status: 200, body: { pool: "people" } });
    const r = await ask({ orgId: ORG, audienceId: CRM_PEOPLE, brandId: BRAND, email: "a@x.test" });
    expect(r.status).toBe(502);
  });

  it("unknown audience, foreign org or foreign brand = 404", async () => {
    expect((await ask({ orgId: ORG, audienceId: UNKNOWN, brandId: BRAND, email: "a@x.test" })).status).toBe(404);
    expect((await ask({ orgId: OTHER_ORG, audienceId: CRM_PEOPLE, brandId: BRAND, email: "a@x.test" })).status).toBe(404);
    expect((await ask({ orgId: ORG, audienceId: CRM_PEOPLE, brandId: UNKNOWN, email: "a@x.test" })).status).toBe(404);
  });

  it("400 on a bad body", async () => {
    expect((await ask({ orgId: ORG, audienceId: CRM_PEOPLE, brandId: BRAND })).status).toBe(400);
  });

  it("offer audience: a business it found through the brand's Google Maps list fits it (GMAPS-SET-ASIDE-1127)", async () => {
    const LIST = "00000000-0000-4000-8000-0000000000e1";
    const TARGET = "00000000-0000-4000-8000-0000000000e2";
    await db.insert(audiences).values([
      { id: LIST, orgId: ORG, brandId: BRAND, name: "Swiss shops (Google Maps)", provider: "google_maps", role: "search", status: "active" },
      { id: TARGET, orgId: ORG, brandId: BRAND, name: "Independent drugstores", provider: "apollo", role: "target", status: "active" },
    ] as never);
    // The reveal tags the business as a member of the LIST it walked, never of the target.
    await tagAudienceServe(ORG, LIST, [contact({ email: "apotheke@shop.test", provider: "google_maps" as never, providerPersonId: "ChIJplace1" })]);
    const [person] = await db.select({ id: people.id }).from(people).where(and(eq(people.orgId, ORG), eq(people.emailNorm, "apotheke@shop.test")));
    await db.insert(googleMapsBrandClaims).values({ orgId: ORG, brandId: BRAND, placeId: "ChIJplace1", audienceId: LIST, personId: person.id } as never);
    const ask1 = () => ask({ orgId: ORG, audienceId: TARGET, brandId: BRAND, email: "apotheke@shop.test", personId: person.id });

    // Before the target's candidate is served: it never found them.
    const before = await ask1();
    expect(before.status).toBe(422);
    expect(before.body.code).toBe("not_found_by_audience");

    await db.insert(audienceCandidates).values({
      orgId: ORG, audienceId: TARGET, providerPersonId: "ChIJplace1", status: "revealed", searchAudienceId: LIST,
      revealResult: { status: "served", personId: person.id, person: null },
    } as never);
    const r = await ask1();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ fits: true, basis: "found_by_search" });
  });

  it("offer audience: a candidate it did NOT serve is not a find", async () => {
    const LIST = "00000000-0000-4000-8000-0000000000e3";
    const TARGET = "00000000-0000-4000-8000-0000000000e4";
    await db.insert(audiences).values([
      { id: LIST, orgId: ORG, brandId: BRAND, name: "Swiss shops (Google Maps)", provider: "google_maps", role: "search", status: "active" },
      { id: TARGET, orgId: ORG, brandId: BRAND, name: "Independent drugstores", provider: "apollo", role: "target", status: "active" },
    ] as never);
    await tagAudienceServe(ORG, LIST, [contact({ email: "other@shop.test", provider: "google_maps" as never, providerPersonId: "ChIJplace2" })]);
    const [person] = await db.select({ id: people.id }).from(people).where(and(eq(people.orgId, ORG), eq(people.emailNorm, "other@shop.test")));
    await db.insert(googleMapsBrandClaims).values({ orgId: ORG, brandId: BRAND, placeId: "ChIJplace2", audienceId: LIST, personId: person.id } as never);
    await db.insert(audienceCandidates).values({
      orgId: ORG, audienceId: TARGET, providerPersonId: "ChIJplace2", status: "revealed", searchAudienceId: LIST,
      revealResult: { status: "not_served", reason: "already_served", person: null },
    } as never);
    const r = await ask({ orgId: ORG, audienceId: TARGET, brandId: BRAND, email: "other@shop.test", personId: person.id });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("not_found_by_audience");
  });

  it("offer audience: a Google Maps find the brand handed back (claim released) no longer fits, with its reason", async () => {
    const LIST = "00000000-0000-4000-8000-0000000000e5";
    const TARGET = "00000000-0000-4000-8000-0000000000e6";
    await db.insert(audiences).values([
      { id: LIST, orgId: ORG, brandId: BRAND, name: "Swiss shops (Google Maps)", provider: "google_maps", role: "search", status: "active" },
      { id: TARGET, orgId: ORG, brandId: BRAND, name: "Independent drugstores", provider: "apollo", role: "target", status: "active" },
    ] as never);
    await tagAudienceServe(ORG, LIST, [contact({ email: "released@shop.test", provider: "google_maps" as never, providerPersonId: "ChIJplace3" })]);
    const [person] = await db.select({ id: people.id }).from(people).where(and(eq(people.orgId, ORG), eq(people.emailNorm, "released@shop.test")));
    const r = await ask({ orgId: ORG, audienceId: TARGET, brandId: BRAND, email: "released@shop.test", personId: person.id });
    expect(r.status).toBe(200);
    expect(r.body.fits).toBe(false);
    expect(r.body.failed).toEqual([{ code: "find_released", reason: expect.any(String) }]);
  });

  it("search audience: a member it found fits; nothing written, nothing fetched", async () => {
    await tagAudienceServe(ORG, APOLLO, [contact({ email: "founder@acme.test", providerPersonId: "ap-1" })]);
    const before = {
      members: (await db.select().from(audienceMembers)).length,
      serves: (await db.select().from(leadServes)).length,
      supp: (await db.select().from(brandSuppressions)).length,
    };
    const r = await ask({ orgId: ORG, audienceId: APOLLO, brandId: BRAND, email: "Founder@Acme.test" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ fits: true, basis: "found_by_search" });
    expect(crmCalls).toHaveLength(0);
    expect((await db.select().from(audienceMembers)).length).toBe(before.members);
    expect((await db.select().from(leadServes)).length).toBe(before.serves);
    expect((await db.select().from(brandSuppressions)).length).toBe(before.supp);
  });

  it("search audience: screened out since = no longer fits", async () => {
    await tagAudienceServe(ORG, APOLLO, [contact({ email: "founder@acme.test", providerPersonId: "ap-1" })]);
    await db.insert(audienceScreenedOut).values({ orgId: ORG, audienceId: APOLLO, providerPersonId: "ap-1", reason: "declined" });
    const r = await ask({ orgId: ORG, audienceId: APOLLO, brandId: BRAND, email: "founder@acme.test" });
    expect(r.body).toMatchObject({ fits: false, basis: "found_by_search", failed: [{ code: "screened_out" }] });
    expect(typeof r.body.reason).toBe("string");
  });

  it("search audience: a person it never found = 422", async () => {
    const r = await ask({ orgId: ORG, audienceId: APOLLO, brandId: BRAND, email: "stranger@x.test" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("person_unknown");
  });
});
