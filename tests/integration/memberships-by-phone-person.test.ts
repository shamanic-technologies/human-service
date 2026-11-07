import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audienceMembers, audiences, googleMapsBrandClaims, people } from "../../src/db/schema.js";
import { resolveIdentity } from "../../src/services/human-identity.js";

// AUDIENCE-PER-OFFER-1107: crm-service asks "which offer of brand B reached this
// person?" by PHONE and by PERSON / HUMAN id, on the same membership rows the
// by-email read answers.

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000d1";
const OFFER_1 = "00000000-0000-4000-8000-0000000000e1";
const OFFER_2 = "00000000-0000-4000-8000-0000000000e2";
const ORG = getAuthHeaders()["x-org-id"];
const OTHER_ORG = "00000000-0000-4000-8000-0000000000f9";
const KEY = { "X-API-Key": "test-api-key", "Content-Type": "application/json" };

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

async function audience(offerId: string, name: string) {
  const [a] = await db
    .insert(audiences)
    .values({ orgId: ORG, brandId: BRAND, offerId, name, provider: "apollo", status: "active" })
    .returning({ id: audiences.id });
  return a.id;
}

async function person(orgId: string, emailNorm: string | null, humanId: string | null = null) {
  const [p] = await db.insert(people).values({ orgId, emailNorm, humanId }).returning({ id: people.id });
  return p.id;
}

async function member(audienceId: string, personId: string, provenance: string, joinedAt: string) {
  await db.insert(audienceMembers).values({ orgId: ORG, audienceId, personId, provenance, joinedAt: new Date(joinedAt) });
}

async function seed() {
  const a1 = await audience(OFFER_1, "Offer 1 audience");
  const a2 = await audience(OFFER_2, "Offer 2 audience");
  // One human, two mailboxes = two persons of the org; the phone is on the human.
  const h = await resolveIdentity({
    orgId: null,
    keys: [
      { kind: "email", valueNorm: "p1@x.com" },
      { kind: "phone", valueNorm: "+33612345678" },
    ],
    source: "test",
    create: true,
  });
  const p1 = await person(ORG, "p1@x.com", h.atomicHumanId);
  const p1b = await person(ORG, "p1.perso@x.com", h.atomicHumanId);
  await member(a1, p1, "served", "2026-01-01T00:00:00Z");
  await member(a2, p1, "found_taken", "2026-02-01T00:00:00Z");
  await member(a2, p1b, "served", "2025-12-01T00:00:00Z");
  // A business a Google Maps audience served: a phone, no email, no human key.
  const p3 = await person(ORG, null);
  await db.insert(googleMapsBrandClaims).values({ orgId: ORG, brandId: BRAND, placeId: "place-1", phoneE164: "+5511999998888", audienceId: a2, personId: p3 });
  await member(a2, p3, "served", "2026-03-01T00:00:00Z");
  // Another org's person on the same human: never answered for ORG.
  const other = await person(OTHER_ORG, "p1@x.com", h.atomicHumanId);
  return { a1, a2, p1, p1b, p3, other, humanId: h.humanId as string };
}

describe("POST /internal/brands/:brandId/memberships/by-phone", () => {
  it("answers every person of the org at that number, oldest membership first", async () => {
    const s = await seed();
    const res = await request(app)
      .post(`/internal/brands/${BRAND}/memberships/by-phone`)
      .set(KEY)
      .send({ orgId: ORG, phones: ["+33 6 12 34 56 78", "+5511999998888", "+14155550000", "not a phone"] });
    expect(res.status).toBe(200);
    const hit = res.body.byPhone["+33 6 12 34 56 78"];
    expect(hit.humanId).toBe(s.humanId);
    expect(hit.personIds).toEqual([s.p1, s.p1b].sort());
    expect(hit.memberships.map((m: { personId: string; audienceId: string; offerId: string; provenance: string }) => [m.personId, m.audienceId, m.offerId, m.provenance])).toEqual([
      [s.p1b, s.a2, OFFER_2, "served"],
      [s.p1, s.a1, OFFER_1, "served"],
      [s.p1, s.a2, OFFER_2, "found_taken"],
    ]);
    const maps = res.body.byPhone["+5511999998888"];
    expect(maps).toMatchObject({ humanId: null, personIds: [s.p3] });
    expect(maps.memberships).toHaveLength(1);
    expect(maps.memberships[0]).toMatchObject({ personId: s.p3, audienceId: s.a2, offerId: OFFER_2, provenance: "served" });
    expect(res.body.byPhone["+14155550000"]).toBeNull();
    expect(res.body.byPhone["not a phone"]).toBeNull();
  });

  it("matches the by-email rows for the same person", async () => {
    const s = await seed();
    const email = await request(app)
      .post(`/internal/brands/${BRAND}/memberships/by-email`)
      .set(KEY)
      .send({ orgId: ORG, emails: ["p1@x.com"] });
    const phone = await request(app)
      .post(`/internal/brands/${BRAND}/memberships/by-phone`)
      .set(KEY)
      .send({ orgId: ORG, phones: ["+33612345678"] });
    const strip = ({ personId: _p, ...m }: Record<string, unknown>) => m;
    expect(phone.body.byPhone["+33612345678"].memberships.filter((m: { personId: string }) => m.personId === s.p1).map(strip)).toEqual(
      email.body.byEmail["p1@x.com"].memberships
    );
  });

  it("400s without phones, 401s without a key", async () => {
    const bad = await request(app).post(`/internal/brands/${BRAND}/memberships/by-phone`).set(KEY).send({ orgId: ORG, phones: [] });
    expect(bad.status).toBe(400);
    const anon = await request(app).post(`/internal/brands/${BRAND}/memberships/by-phone`).send({ orgId: ORG, phones: ["+33612345678"] });
    expect(anon.status).toBe(401);
  });
});

describe("POST /internal/brands/:brandId/memberships/by-person", () => {
  it("answers by person id (by-email entry shape) and by human id (by-phone entry shape)", async () => {
    const s = await seed();
    const unknown = "00000000-0000-4000-8000-0000000000aa";
    const res = await request(app)
      .post(`/internal/brands/${BRAND}/memberships/by-person`)
      .set(KEY)
      .send({ orgId: ORG, personIds: [s.p1, s.other, unknown], humanIds: [s.humanId, unknown] });
    expect(res.status).toBe(200);

    const email = await request(app)
      .post(`/internal/brands/${BRAND}/memberships/by-email`)
      .set(KEY)
      .send({ orgId: ORG, emails: ["p1@x.com"] });
    expect(res.body.byPersonId[s.p1]).toMatchObject({
      personId: s.p1,
      humanId: s.humanId,
      memberships: email.body.byEmail["p1@x.com"].memberships,
    });
    expect(res.body.byPersonId[s.other]).toBeNull();
    expect(res.body.byPersonId[unknown]).toBeNull();

    const phone = await request(app)
      .post(`/internal/brands/${BRAND}/memberships/by-phone`)
      .set(KEY)
      .send({ orgId: ORG, phones: ["+33612345678"] });
    expect(res.body.byHumanId[s.humanId]).toEqual(phone.body.byPhone["+33612345678"]);
    expect(res.body.byHumanId[unknown]).toBeNull();
  });

  it("400s with neither personIds nor humanIds, or a non-uuid id", async () => {
    const none = await request(app).post(`/internal/brands/${BRAND}/memberships/by-person`).set(KEY).send({ orgId: ORG });
    expect(none.status).toBe(400);
    const bad = await request(app).post(`/internal/brands/${BRAND}/memberships/by-person`).set(KEY).send({ orgId: ORG, personIds: ["nope"] });
    expect(bad.status).toBe(400);
  });
});
