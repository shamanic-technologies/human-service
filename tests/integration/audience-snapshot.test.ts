import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  audienceCandidates,
  audienceMembers,
  audiences,
  audienceTeaserBuffer,
  audienceTeaserScreenings,
  people,
} from "../../src/db/schema.js";

// The staff snapshot reads what a brand holds: revealed people, screened and
// buffered teasers, keyed on the provider person id, with the screen's verdict
// re-read at today's bar. No provider is called, so no fetch is stubbed.

const app = createTestApp();
const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000009";
const BRAND = "00000000-0000-4000-8000-0000000000c1";
const OTHER_BRAND = "00000000-0000-4000-8000-0000000000c2";

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

function snap(name: string, org: string | null) {
  return {
    name: null, title: `${name} title`, headline: null, seniority: null,
    city: null, state: null, country: null,
    organizationName: org, organizationIndustry: null, organizationEmployees: null,
    organizationCity: null, organizationState: null, organizationCountry: null,
    organizationKeywords: null,
  };
}

async function audience(name: string, opts: { brandId?: string; orgId?: string; filters?: unknown } = {}) {
  const [row] = await db
    .insert(audiences)
    .values({
      orgId: opts.orgId ?? ORG,
      brandId: opts.brandId ?? BRAND,
      name,
      provider: "apollo",
      filters: (opts.filters ?? { person_titles: ["Partner"] }) as Record<string, unknown>,
      status: "active",
      targetText: `${name} target`,
    })
    .returning();
  return row;
}

async function screen(audienceId: string, pid: string, org: string | null, yes: number | null, verdict: boolean, orgId = ORG) {
  await db.insert(audienceTeaserScreenings).values({
    orgId, audienceId, providerPersonId: pid, teaser: snap(pid, org),
    verdict, yesProbability: yes, model: "typesafe/test", promptVersion: yes === null ? "v1" : "v2",
  });
}

async function reveal(audienceId: string, pid: string | null, domain: string, orgId = ORG) {
  const [p] = await db
    .insert(people)
    .values({ orgId, apolloPersonId: pid, emailNorm: `${pid ?? domain}@${domain}`, fullName: `Person ${pid}`, title: "Partner", companyDomain: domain })
    .returning();
  await db.insert(audienceMembers).values({ orgId, audienceId, personId: p.id, source: "apollo" });
  return p;
}

async function seed() {
  const a = await audience("Managing Partners");
  const b = await audience("Hiring firms", { filters: { buying_signal: { type: "hiring", window_days: 30 } } });
  const foreign = await audience("Other brand");

  // p1: screened (accepted) then revealed under A, also accepted by B.
  await screen(a.id, "p1", "Smith Law", 0.9, true);
  await reveal(a.id, "p1", "smithlaw.com");
  await screen(b.id, "p1", "Smith Law", 0.7, true);
  // p2: same company by NAME only (teaser), rejected by A. Joins smithlaw.com via the name map.
  await screen(a.id, "p2", "Smith Law", 0.2, false);
  // p3: judged 0.65 under the old 0.80 bar (verdict false) -> accepted at today's bar.
  await screen(a.id, "p3", "Jones LLP", 0.65, false);
  // p4: re-screened: first accepted, latest rejected -> rejected.
  await screen(a.id, "p4", "Jones LLP", 0.9, true);
  await new Promise((r) => setTimeout(r, 5));
  await screen(a.id, "p4", "Jones LLP", 0.3, false);
  // p5: buffered only under B.
  await db.insert(audienceTeaserBuffer).values({ orgId: ORG, audienceId: b.id, providerPersonId: "p5", teaser: snap("p5", "Lone Firm") });
  // p6: revealed before the screen existed, no provider id.
  await reveal(a.id, null, "oldfirm.com");
  // v1 row: no probability, verdict stands.
  await screen(b.id, "p7", null, null, true);

  // Another brand's data never leaks in.
  await db.update(audiences).set({ brandId: OTHER_BRAND }).where((await import("drizzle-orm")).eq(audiences.id, foreign.id));
  await screen(foreign.id, "p1", "Smith Law", 0.99, true);
  return { a, b };
}

describe("GET /internal/brands/:brandId/audience-snapshot", () => {
  it("counts per audience and brand-wide, deduping a person across lists", async () => {
    const { a, b } = await seed();
    const res = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot`).set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.acceptanceBar).toBe(0.5);
    const byId = Object.fromEntries(res.body.audiences.map((x: { audienceId: string }) => [x.audienceId, x]));
    expect(Object.keys(byId).sort()).toEqual([a.id, b.id].sort());

    expect(byId[a.id].list).toBe("apollo_search");
    expect(byId[a.id].people).toEqual({ held: 5, revealed: 2, screened: 4, accepted: 2, rejected: 2, waiting: 0 });
    // smithlaw.com (p1 + p2 by name), Jones LLP (p3, p4), oldfirm.com (p6)
    expect(byId[a.id].companies).toEqual({ held: 3, revealed: 2, accepted: 2 });

    expect(byId[b.id].list).toBe("apollo_buying_signal");
    expect(byId[b.id].people).toEqual({ held: 3, revealed: 0, screened: 2, accepted: 2, rejected: 0, waiting: 1 });
    // smithlaw.com (p1), Lone Firm (p5); p7 has no company.
    expect(byId[b.id].companies).toEqual({ held: 2, revealed: 0, accepted: 1 });

    expect(res.body.totals.people).toEqual({ held: 7, revealed: 2, screened: 5, accepted: 3, rejected: 2, waiting: 1 });
    expect(res.body.totals.companies).toEqual({ held: 4, revealed: 2, accepted: 2 });
  });

  it("narrows to one org when asked", async () => {
    await seed();
    await audience("Elsewhere", { orgId: OTHER_ORG });
    const all = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot`).set(getAuthHeaders());
    const one = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot?orgId=${ORG}`).set(getAuthHeaders());
    expect(all.body.audiences).toHaveLength(3);
    expect(one.body.audiences).toHaveLength(2);
  });

  it("rejects a bad brand id and a missing api key", async () => {
    expect((await request(app).get(`/internal/brands/nope/audience-snapshot`).set(getAuthHeaders())).status).toBe(400);
    expect((await request(app).get(`/internal/brands/${BRAND}/audience-snapshot`)).status).toBe(401);
  });
});

describe("GET /internal/brands/:brandId/audience-snapshot/people", () => {
  it("lists each person once with sources and accepting audiences, paginated", async () => {
    const { a, b } = await seed();
    const res = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot/people?limit=3`).set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(7);
    expect(res.body.people).toHaveLength(3);
    const p1 = res.body.people[0];
    expect(p1.personKey).toBe("p1");
    expect(p1.revealed).toBe(true);
    expect(p1.personId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p1.company).toEqual({ companyKey: "domain:smithlaw.com", name: "Smith Law", domain: "smithlaw.com" });
    expect(p1.acceptedBy.map((x: { audienceId: string }) => x.audienceId).sort()).toEqual([a.id, b.id].sort());
    expect(p1.sources.find((s: { audienceId: string }) => s.audienceId === a.id)).toMatchObject({ stage: "revealed", verdict: "accepted", name: "Managing Partners" });

    const page2 = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot/people?limit=3&offset=6`).set(getAuthHeaders());
    expect(page2.body.people).toHaveLength(1);
    expect(page2.body.total).toBe(7);
  });

  it("acceptedOnly keeps people at least one target accepted", async () => {
    await seed();
    const res = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot/people?acceptedOnly=true`).set(getAuthHeaders());
    expect(res.body.total).toBe(3);
    expect(res.body.people.map((p: { personKey: string }) => p.personKey).sort()).toEqual(["p1", "p3", "p7"]);
    const p2 = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot/people?limit=500`).set(getAuthHeaders());
    const rej = p2.body.people.find((p: { personKey: string }) => p.personKey === "p2");
    expect(rej.acceptedBy).toEqual([]);
    expect(rej.company.companyKey).toBe("domain:smithlaw.com");
    expect(rej.sources[0]).toMatchObject({ stage: "screened", verdict: "rejected", yesProbability: 0.2 });
  });

  it("answers an empty page for a brand with nothing held", async () => {
    const res = await request(app).get(`/internal/brands/${OTHER_BRAND}/audience-snapshot/people`).set(getAuthHeaders());
    expect(res.body).toMatchObject({ total: 0, people: [], limit: 50, offset: 0 });
  });
});

describe("GET /internal/brands/:brandId/audience-snapshot/companies", () => {
  it("groups people by company with sources and accepting audiences", async () => {
    const { a, b } = await seed();
    const res = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot/companies`).set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    const smith = res.body.companies.find((c: { companyKey: string }) => c.companyKey === "domain:smithlaw.com");
    expect(smith).toMatchObject({ companyKey: "domain:smithlaw.com", name: "Smith Law", domain: "smithlaw.com" });
    expect(smith.people).toEqual({ held: 2, revealed: 1, accepted: 1 });
    expect(smith.acceptedBy.map((x: { audienceId: string }) => x.audienceId).sort()).toEqual([a.id, b.id].sort());
    expect(smith.sources.find((s: { audienceId: string }) => s.audienceId === a.id)).toMatchObject({ people: 2, accepted: 1 });

    const accepted = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot/companies?acceptedOnly=true`).set(getAuthHeaders());
    expect(accepted.body.total).toBe(2);
    const lone = res.body.companies.find((c: { companyKey: string }) => c.companyKey === "name:lone firm");
    expect(lone).toMatchObject({ name: "Lone Firm", domain: null, acceptedBy: [] });
  });
});

describe("GET /internal/brands/:brandId/audience-snapshot/person-companies", () => {
  it("answers every held person's company in one read, equal to what /people pages carry", async () => {
    await seed();
    const res = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot/person-companies?orgId=${ORG}`).set(getAuthHeaders());
    expect(res.status).toBe(200);
    const pages = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot/people?orgId=${ORG}&limit=500`).set(getAuthHeaders());
    const expected = Object.fromEntries(
      pages.body.people
        .filter((p: { providerPersonId: string | null }) => p.providerPersonId)
        .map((p: { providerPersonId: string; company: unknown }) => [p.providerPersonId, p.company])
    );
    const got = Object.fromEntries(res.body.people.map((p: { providerPersonId: string; company: unknown }) => [p.providerPersonId, p.company]));
    expect(got).toEqual(expected);
    // p6 has no provider id, so 6 of the 7 held people.
    expect(res.body.total).toBe(6);
    expect(got.p2).toEqual({ companyKey: "domain:smithlaw.com", name: "Smith Law", domain: "smithlaw.com" });
    expect(got.p5).toEqual({ companyKey: "name:lone firm", name: "Lone Firm", domain: null });
    expect(got.p7).toBeNull();
  });

  it("answers an empty list for a brand with nothing held, and rejects a bad brand id / missing key", async () => {
    const res = await request(app).get(`/internal/brands/${OTHER_BRAND}/audience-snapshot/person-companies`).set(getAuthHeaders());
    expect(res.body).toEqual({ brandId: OTHER_BRAND, total: 0, people: [] });
    expect((await request(app).get(`/internal/brands/nope/audience-snapshot/person-companies`).set(getAuthHeaders())).status).toBe(400);
    expect((await request(app).get(`/internal/brands/${BRAND}/audience-snapshot/person-companies`)).status).toBe(401);
  });
});

// Since 2026-10-07 lead-service decides on the candidate path: a revealed
// candidate is accepted by its target, a declined one is not. The legacy seed
// above (screen verdicts only) keeps its exact counts.
describe("candidate-path decisions", () => {
  async function candidate(audienceId: string, pid: string, org: string, status: "offered" | "revealing" | "revealed" | "declined", domain: string | null = null) {
    await db.insert(audienceCandidates).values({
      orgId: ORG, audienceId, providerPersonId: pid, teaser: snap(pid, org), organizationDomain: domain,
      status, decidedAt: status === "offered" ? null : new Date(),
    });
  }

  it("reads revealed as accepted, declined as rejected, offered as waiting, on every surface", async () => {
    const r = await audience("Roofing Companies");
    await candidate(r.id, "c1", "Acme Roofing", "revealed", "acmeroofing.com");
    await reveal(r.id, "c1", "acmeroofing.com");
    await candidate(r.id, "c2", "Best Roofs", "revealed");
    await candidate(r.id, "c3", "Acme Roofing", "declined", "acmeroofing.com");
    await candidate(r.id, "c4", "Cold Co", "declined");
    await candidate(r.id, "c5", "New Co", "offered");
    await candidate(r.id, "c6", "Mid Co", "revealing");

    const s = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot`).set(getAuthHeaders());
    const row = s.body.audiences.find((x: { audienceId: string }) => x.audienceId === r.id);
    expect(row.people).toEqual({ held: 6, revealed: 1, screened: 5, accepted: 3, rejected: 2, waiting: 1 });
    expect(row.companies).toEqual({ held: 5, revealed: 1, accepted: 3 });
    expect(s.body.totals.people.accepted).toBe(3);

    const ppl = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot/people?acceptedOnly=true`).set(getAuthHeaders());
    expect(ppl.body.total).toBe(3);
    expect(ppl.body.people.map((p: { personKey: string }) => p.personKey).sort()).toEqual(["c1", "c2", "c6"]);
    const c1 = ppl.body.people.find((p: { personKey: string }) => p.personKey === "c1");
    expect(c1.acceptedBy.map((x: { audienceId: string }) => x.audienceId)).toEqual([r.id]);
    expect(c1.company.companyKey).toBe("domain:acmeroofing.com");

    const all = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot/people?limit=500`).set(getAuthHeaders());
    const c3 = all.body.people.find((p: { personKey: string }) => p.personKey === "c3");
    expect(c3.sources[0]).toMatchObject({ stage: "screened", verdict: "rejected" });
    expect(c3.acceptedBy).toEqual([]);

    const cos = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot/companies?acceptedOnly=true`).set(getAuthHeaders());
    expect(cos.body.total).toBe(3);
    const acme = cos.body.companies.find((c: { companyKey: string }) => c.companyKey === "domain:acmeroofing.com");
    expect(acme.people).toEqual({ held: 2, revealed: 1, accepted: 1 });
    expect(acme.acceptedBy).toEqual([expect.objectContaining({ audienceId: r.id, acceptedPeople: 1 })]);
  });

  it("the later of a screen verdict and a candidate decision wins", async () => {
    const r = await audience("Mixed");
    await screen(r.id, "m1", "Old Co", 0.9, true);
    await new Promise((res) => setTimeout(res, 5));
    await candidate(r.id, "m1", "Old Co", "declined");
    const s = await request(app).get(`/internal/brands/${BRAND}/audience-snapshot`).set(getAuthHeaders());
    const row = s.body.audiences.find((x: { audienceId: string }) => x.audienceId === r.id);
    expect(row.people).toMatchObject({ held: 1, screened: 1, accepted: 0, rejected: 1 });
  });
});
