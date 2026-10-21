import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audienceCandidates, audienceScreenedOut } from "../../src/db/schema.js";

// CRM-SERVE-FIND-EMAIL-1021: a CRM-served person goes through the candidate
// frontier (qualified by the caller before any spend); a contact the client added
// without an email has it looked up at REVEAL time, billed by apollo-service on
// the serve's run, then written back to crm-service.

vi.mock("../../src/lib/lead-won.js", () => ({
  listWonEmails: vi.fn(async () => []),
  isEmailWon: vi.fn(async () => false),
  WonLeadsSourceError: class WonLeadsSourceError extends Error {},
  WonLeadsConfigError: class WonLeadsConfigError extends Error {},
}));
vi.mock("../../src/services/bounces.js", () => ({
  filterBounced: vi.fn(async (_identity: unknown, items: unknown[]) => items),
  isEmailBounced: vi.fn(async () => false),
}));
vi.mock("../../src/lib/instantly-optouts.js", () => ({
  listStandingOptOutEmails: vi.fn(async () => []),
  isEmailOptedOut: vi.fn(async () => false),
  OptOutSourceError: class OptOutSourceError extends Error {},
  OptOutConfigError: class OptOutConfigError extends Error {},
}));

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000d1";
const RUN = getAuthHeaders()["x-run-id"];

const fetchSpy = vi.fn();
const fetchBeforeThisSuite = globalThis.fetch;

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.CRM_SERVICE_URL = "http://crm:8080";
  process.env.CRM_SERVICE_API_KEY = "crm-key";
  await cleanTestData();
});

afterAll(async () => {
  globalThis.fetch = fetchBeforeThisSuite;
  await closeDb();
});

function ok(json: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) };
}

// A staff test person, never a real one.
function unknownContact(id = "11111111-1111-4111-8111-111111111111") {
  return {
    id,
    primaryEmail: null,
    phoneE164: null,
    fullName: "Test Staffer",
    firstName: "Test",
    lastName: "Staffer",
    companyName: "Distribute Test Co",
    companyDomain: "distribute-test.example",
    jobTitle: "Head of Automation",
    linkedinUrl: "https://www.linkedin.com/in/test-staffer",
    note: null,
    emailStatus: "unknown",
  };
}

function knownContact(id = "22222222-2222-4222-8222-222222222222") {
  return { ...unknownContact(id), primaryEmail: "k.lourd+crmknown@distribute-test.example", emailStatus: "known" };
}

interface Fleet {
  crmBodies: Record<string, unknown>[];
  finds: { body: Record<string, unknown>; runId: string | undefined }[];
  writeBacks: { contactId: string; body: Record<string, unknown> }[];
}

function mockFleet(opts: {
  contacts: unknown[][];
  find?: Record<string, unknown>;
}): Fleet {
  const fleet: Fleet = { crmBodies: [], finds: [], writeBacks: [] };
  let page = 0;
  fetchSpy.mockImplementation(async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
    const u = String(url);
    if (u.endsWith("/orgs/contacts/serve-next")) {
      fleet.crmBodies.push(JSON.parse(init.body ?? "{}"));
      const contacts = opts.contacts[page] ?? [];
      page += 1;
      return ok({ contacts, served: contacts.length, exhausted: contacts.length === 0 });
    }
    const lookup = u.match(/\/orgs\/contacts\/([^/]+)\/email-lookup$/);
    if (lookup) {
      const body = JSON.parse(init.body ?? "{}");
      fleet.writeBacks.push({ contactId: lookup[1], body });
      return ok({ contactId: lookup[1], status: body.status, email: body.email ?? null, emailStatus: body.status === "found" ? "known" : "not_found", duplicateOf: null, served: body.status === "found" });
    }
    if (u.endsWith("/email-finder/find")) {
      fleet.finds.push({ body: JSON.parse(init.body ?? "{}"), runId: init.headers?.["x-run-id"] });
      return ok(opts.find ?? { status: "not_found", found: false, reused: false });
    }
    throw new Error("unexpected url " + u);
  });
  return fleet;
}

async function createCrmAudience() {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({ name: "Contacts added one by one", brandId: BRAND, provider: "crm" });
  expect(res.status).toBe(201);
  return res.body.audience.id as string;
}

const next = (id: string, body: object = {}) =>
  request(app).post(`/orgs/audiences/${id}/candidates/next`).set(getAuthHeaders()).send(body);
const reveal = (id: string, c: string, body: object = {}) =>
  request(app).post(`/orgs/audiences/${id}/candidates/${c}/reveal`).set(getAuthHeaders()).send(body);

const FOUND = {
  status: "found",
  found: true,
  email: "k.lourd+crmfound@distribute-test.example",
  reused: false,
  emailVerification: { email: "k.lourd+crmfound@distribute-test.example", verdict: "valid", deliverable: true },
};

describe("CRM candidates — a contact added without an email", () => {
  it("is offered free, then its email is looked up at reveal on the serve's run, written back, and served", async () => {
    const id = await createCrmAudience();
    const fleet = mockFleet({ contacts: [[unknownContact()]], find: FOUND });

    const offered = await next(id);
    expect(offered.status).toBe(200);
    expect(offered.body.status).toBe("candidate");
    expect(offered.body.candidate.person).toMatchObject({ name: "Test Staffer", title: "Head of Automation" });
    expect(offered.body.candidate.company).toMatchObject({ name: "Distribute Test Co", domain: "distribute-test.example" });
    expect(fleet.crmBodies[0]).toMatchObject({ brandId: BRAND, limit: 1, includeEmailUnknown: true });
    // Nothing paid before the caller decided.
    expect(fleet.finds).toEqual([]);

    const res = await reveal(id, offered.body.candidate.candidateId, { basis: "screen:lead-v1;must:none" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe(FOUND.email);
    expect(typeof res.body.personId).toBe("string");
    expect(fleet.finds).toHaveLength(1);
    expect(fleet.finds[0].body).toEqual({
      vendor: "treg",
      person: { firstName: "Test", lastName: "Staffer", domain: "distribute-test.example", linkedinUrl: "https://www.linkedin.com/in/test-staffer" },
    });
    // The cost lands on the campaign's serve run: apollo-service bills x-run-id.
    expect(fleet.finds[0].runId).toBe(RUN);
    expect(fleet.writeBacks).toEqual([
      { contactId: unknownContact().id, body: { brandId: BRAND, status: "found", email: FOUND.email } },
    ]);

    // Replayed, never re-bought.
    const again = await reveal(id, offered.body.candidate.candidateId);
    expect(again.body.replayed).toBe(true);
    expect(fleet.finds).toHaveLength(1);
  });

  it("not found: written back, not served, never looked up twice (a second hand-out is skipped)", async () => {
    const id = await createCrmAudience();
    // crm-service hands the same contact out again (24 h TTL), then nobody.
    const fleet = mockFleet({ contacts: [[unknownContact()], [unknownContact()], []] });
    const offered = await next(id);
    const res = await reveal(id, offered.body.candidate.candidateId);
    expect(res.body).toMatchObject({ status: "not_served", person: null, reason: "email_not_found" });
    expect(fleet.writeBacks).toEqual([{ contactId: unknownContact().id, body: { brandId: BRAND, status: "not_found" } }]);

    const after = await next(id);
    expect(after.body).toMatchObject({ status: "exhausted", reason: "pool_exhausted" });
    expect(fleet.finds).toHaveLength(1);
  });

  it("a lookup still running hands the candidate back, nothing written back", async () => {
    const id = await createCrmAudience();
    const fleet = mockFleet({ contacts: [[unknownContact()]], find: { status: "pending", reused: false } });
    const offered = await next(id);
    const res = await reveal(id, offered.body.candidate.candidateId);
    expect(res.body).toMatchObject({ status: "not_served", reason: "email_lookup_pending" });
    const [row] = await db.select().from(audienceCandidates).where(eq(audienceCandidates.id, offered.body.candidate.candidateId));
    expect(row.status).toBe("offered");
    expect(fleet.writeBacks).toEqual([]);
  });

  it("a found address the caller's policy refuses is written back (served there) but not served here", async () => {
    const id = await createCrmAudience();
    const fleet = mockFleet({
      contacts: [[unknownContact()]],
      find: { ...FOUND, emailVerification: { verdict: "catch_all", deliverable: false } },
    });
    const offered = await next(id);
    const res = await reveal(id, offered.body.candidate.candidateId);
    expect(res.body).toMatchObject({ status: "not_served", reason: "not_deliverable", verdict: "catch_all" });
    expect(fleet.writeBacks[0].body.status).toBe("found");
  });

  it("nothing to find it with (company name only): no spend, written back not_found", async () => {
    const id = await createCrmAudience();
    const fleet = mockFleet({
      contacts: [[{ ...unknownContact(), companyDomain: null, linkedinUrl: null }]],
    });
    const offered = await next(id);
    const res = await reveal(id, offered.body.candidate.candidateId);
    expect(res.body).toMatchObject({ status: "not_served", reason: "email_not_found" });
    expect(fleet.finds).toEqual([]);
    expect(fleet.writeBacks[0].body.status).toBe("not_found");
  });
});

describe("CRM candidates — a contact with an email", () => {
  it("is offered, then served free (no lookup)", async () => {
    const id = await createCrmAudience();
    const fleet = mockFleet({ contacts: [[knownContact()]] });
    const offered = await next(id);
    expect(offered.body.status).toBe("candidate");
    const res = await reveal(id, offered.body.candidate.candidateId);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe(knownContact().primaryEmail);
    expect(fleet.finds).toEqual([]);
    expect(fleet.writeBacks).toEqual([]);
  });

  it("a declined CRM candidate (failed the caller's screen) is never served", async () => {
    const id = await createCrmAudience();
    mockFleet({ contacts: [[knownContact()]] });
    const offered = await next(id);
    const res = await request(app)
      .post(`/orgs/audiences/${id}/candidates/${offered.body.candidate.candidateId}/decline`)
      .set(getAuthHeaders())
      .send({ reason: "screen_rejected P(yes)=0.100", basis: "screen:lead-v1;must:none" });
    expect(res.status).toBe(200);
    const out = await db.select().from(audienceScreenedOut).where(eq(audienceScreenedOut.audienceId, id));
    expect(out.map((r) => r.providerPersonId)).toEqual([knownContact().id]);
    const r2 = await reveal(id, offered.body.candidate.candidateId);
    expect(r2.status).toBe(409);
  });

  it("serve-next is unchanged: no includeEmailUnknown on the wire", async () => {
    const id = await createCrmAudience();
    const fleet = mockFleet({ contacts: [[knownContact()]] });
    const res = await request(app).post(`/orgs/audiences/${id}/serve-next`).set(getAuthHeaders()).send({});
    expect(res.body.status).toBe("served");
    expect(fleet.crmBodies[0]).toEqual({ brandId: BRAND, limit: 1 });
  });

  it("forwards the pipe's stepFilter and relationships to crm-service on candidates/next", async () => {
    const id = await createCrmAudience();
    const fleet = mockFleet({ contacts: [[knownContact()]] });
    const stepFilter = { reached: ["form_submitted"] };
    const res = await next(id, { stepFilter, relationships: "business_only" });
    expect(res.status).toBe(200);
    expect(fleet.crmBodies[0]).toMatchObject({ stepFilter, relationships: "business_only", includeEmailUnknown: true });
  });
});
