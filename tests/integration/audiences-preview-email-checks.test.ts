import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { brandSuppressions, leadServes, audienceMembers } from "../../src/db/schema.js";

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000d2";

const fetchBefore = globalThis.fetch;
const fetchSpy = vi.fn();

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

function person(i: number) {
  return {
    firstName: `First${i}`,
    lastNameObfuscated: `La***${i}`,
    title: "Founder",
    company: `Company ${i}`,
    apolloPersonId: `apollo-person-${i}`,
  };
}

function sample(n: number, withHandles = true) {
  const people = Array.from({ length: n }, (_, i) => {
    const p = person(i);
    if (!withHandles) delete (p as Partial<typeof p>).apolloPersonId;
    return p;
  });
  return {
    apolloAudienceId: "apollo-aud-reach",
    count: 500,
    companies: people.map((p) => ({ name: p.company, peopleInSample: 1 })),
    people,
  };
}

// apollo-service /enrich answers, keyed by person id.
const ENRICH: Record<string, unknown> = {
  "apollo-person-0": {
    person: { id: "apollo-person-0", email: "jane.doe@company0.com" },
    emailVerification: { email: "jane.doe@company0.com", verdict: "valid", deliverable: true, verifier: "bounceverify" },
  },
  "apollo-person-1": { person: { id: "apollo-person-1", email: null }, emailVerification: null },
  "apollo-person-2": {
    person: { id: "apollo-person-2", email: "x@company2.com" },
    emailVerification: { email: "x@company2.com", verdict: "catch_all", deliverable: false, verifier: "bounceverify" },
  },
};

let previewBody: unknown;
const enrichCalls: string[] = [];

function route() {
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/audiences/apollo-aud-reach/preview")) return ok(previewBody);
    if (u.endsWith("/enrich")) {
      const id = JSON.parse(init.body ?? "{}").apolloPersonId as string;
      enrichCalls.push(id);
      return ok(ENRICH[id] ?? { person: { id, email: null }, emailVerification: null });
    }
    throw new Error("unexpected url " + u);
  });
}

async function createAudience(name: string) {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(getAuthHeaders())
    .send({ brandId: BRAND, name, provider: "apollo", apolloAudienceId: "apollo-aud-reach", filters: { personTitles: ["Founder"] } });
  expect(res.status).toBe(201);
  return res.body.audience.id as string;
}

const next = (id: string) => request(app).post(`/orgs/audiences/${id}/preview/email-checks/next`).set(getAuthHeaders());
const state = (id: string) => request(app).get(`/orgs/audiences/${id}/preview/email-checks`).set(getAuthHeaders());

beforeEach(async () => {
  fetchSpy.mockReset();
  enrichCalls.length = 0;
  vi.stubGlobal("fetch", fetchSpy);
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  previewBody = sample(3);
  route();
  await cleanTestData();
});

afterAll(async () => {
  globalThis.fetch = fetchBefore;
  await closeDb();
});

describe("audience preview email checks", () => {
  it("the free read lists the checked people as pending and runs no reveal", async () => {
    const id = await createAudience("Pending");
    const res = await state(id);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.done).toBe(false);
    expect(res.body.people.map((p: { status: string }) => p.status)).toEqual(["pending", "pending", "pending"]);
    expect(res.body.people[0]).toMatchObject({ index: 0, firstName: "First0", company: "Company 0", finder: null });
    expect(enrichCalls).toEqual([]);
  });

  it("each /next reveals ONE person, in preview order, and reports finder + verdict without the address", async () => {
    const id = await createAudience("Race");

    const first = await next(id);
    expect(first.status).toBe(200);
    expect(enrichCalls).toEqual(["apollo-person-0"]);
    expect(first.body.people[0]).toMatchObject({
      status: "found",
      finder: "apollo",
      verifier: "bounceverify",
      verdict: "valid",
      deliverable: true,
      maskedEmail: "***@company0.com",
    });
    expect(first.body.people[1].status).toBe("pending");
    expect(JSON.stringify(first.body)).not.toContain("jane.doe");
    expect(JSON.stringify(first.body)).not.toContain("apollo-person");

    const second = await next(id);
    expect(second.body.people[1]).toMatchObject({ status: "not_found", finder: "apollo", verdict: null, maskedEmail: null });

    const third = await next(id);
    expect(third.body.people[2]).toMatchObject({ status: "found", verdict: "catch_all", deliverable: false });
    expect(third.body.done).toBe(true);
    expect(third.body.summary).toEqual({ checked: 3, found: 2, deliverable: 1 });

    // Done: no further spend.
    const after = await next(id);
    expect(after.body.done).toBe(true);
    expect(enrichCalls).toEqual(["apollo-person-0", "apollo-person-1", "apollo-person-2"]);
  });

  it("checks at most 5 people of a larger sample", async () => {
    previewBody = sample(8);
    const id = await createAudience("Capped");
    for (let i = 0; i < 7; i++) await next(id);
    const res = await state(id);
    expect(res.body.people).toHaveLength(5);
    expect(res.body.done).toBe(true);
    expect(enrichCalls).toHaveLength(5);
  });

  it("is not a serve: no suppression, no serve record, no membership", async () => {
    const id = await createAudience("Not a serve");
    await next(id);
    expect(await db.select().from(leadServes)).toHaveLength(0);
    expect(await db.select().from(brandSuppressions)).toHaveLength(0);
    expect(await db.select().from(audienceMembers)).toHaveLength(0);
  });

  it("forwards the audience's brand and the caller's org to the billed reveal", async () => {
    const id = await createAudience("Attribution");
    await next(id);
    const call = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith("/enrich"))!;
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(headers["x-org-id"]).toBe(getAuthHeaders()["x-org-id"]);
    expect(headers["x-brand-id"]).toBe(BRAND);
    expect(headers["x-audience-id"]).toBe(id);
  });

  it("a reveal failure is a 502, stores nothing, and the next call retries the same person", async () => {
    const id = await createAudience("Retry");
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/preview")) return ok(previewBody);
      return { ok: false, status: 500, json: async () => ({}), text: async () => "boom" };
    });
    const failed = await next(id);
    expect(failed.status).toBe(502);
    expect((await state(id)).body.people[0].status).toBe("pending");

    route();
    const retried = await next(id);
    expect(retried.body.people[0].status).toBe("found");
    expect(enrichCalls).toEqual(["apollo-person-0"]);
  });

  it("an email without a verdict fails loud and stores nothing", async () => {
    const id = await createAudience("No verdict");
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/preview")) return ok(previewBody);
      return ok({ person: { email: "a@b.com" }, emailVerification: null });
    });
    const res = await next(id);
    expect(res.status).toBe(502);
    expect((await state(id)).body.people[0].status).toBe("pending");
  });

  it("two concurrent calls never reveal the same person twice", async () => {
    previewBody = sample(1);
    const id = await createAudience("Concurrent");
    await Promise.all([next(id), next(id), next(id)]);
    expect(enrichCalls).toEqual(["apollo-person-0"]);
  });

  it("a sample without reveal handles is unavailable (no_reveal_handle) and spends nothing", async () => {
    previewBody = sample(3, false);
    const id = await createAudience("No handles");
    const res = await next(id);
    expect(res.body).toMatchObject({ status: "unavailable", reason: "no_reveal_handle", done: true, people: [] });
    expect(enrichCalls).toEqual([]);
  });

  it("an unbuilt audience is unavailable with the preview's reason", async () => {
    const res0 = await request(app)
      .post("/orgs/audiences")
      .set(getAuthHeaders())
      .send({ brandId: BRAND, name: "Unbuilt", provider: "apollo", filters: { personTitles: ["CEO"] } });
    const res = await next(res0.body.audience.id);
    expect(res.body).toMatchObject({ status: "unavailable", reason: "not_built_yet" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the preview endpoint never exposes the reveal handle", async () => {
    const id = await createAudience("Handle hidden");
    await next(id);
    const res = await request(app).get(`/orgs/audiences/${id}/preview`).set(getAuthHeaders());
    expect(res.body.people).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toContain("apollo-person");
  });

  it("another org's audience is 404 before any provider call", async () => {
    const id = await createAudience("Foreign");
    const res = await request(app)
      .post(`/orgs/audiences/${id}/preview/email-checks/next`)
      .set({ ...getAuthHeaders(), "x-org-id": "00000000-0000-0000-0000-0000000000ff" });
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
