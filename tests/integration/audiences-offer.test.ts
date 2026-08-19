import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const app = createTestApp();

// 4th group starts with 8/9/a/b — Zod 4 .uuid() is variant-strict (see CLAUDE.md).
const ORG_A = "00000000-0000-0000-0000-000000000001"; // matches getAuthHeaders
const BRAND_1 = "00000000-0000-4000-8000-0000000000a1";
const BRAND_2 = "00000000-0000-4000-8000-0000000000a2";
const OFFER_1 = "00000000-0000-4000-8000-0000000000e1";
const OFFER_2 = "00000000-0000-4000-8000-0000000000e2";

function headers() {
  return getAuthHeaders();
}

async function create(body: Record<string, unknown>) {
  return request(app).post("/orgs/audiences").set(headers()).send(body);
}

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

describe("Audience offer scope — create + read", () => {
  it("creates an audience carrying an offer and reads it back", async () => {
    const res = await create({
      name: "US SaaS founders",
      brandId: BRAND_1,
      offerId: OFFER_1,
    });
    expect(res.status).toBe(201);
    expect(res.body.audience.offerId).toBe(OFFER_1);

    const get = await request(app)
      .get(`/orgs/audiences/${res.body.audience.id}`)
      .set(headers());
    expect(get.status).toBe(200);
    expect(get.body.audience.offerId).toBe(OFFER_1);

    const [row] = await db
      .select()
      .from(audiences)
      .where(eq(audiences.id, res.body.audience.id));
    expect(row.offerId).toBe(OFFER_1);
  });

  it("stores null when no offer is stated — the pre-offer behaviour", async () => {
    const res = await create({ name: "No offer", brandId: BRAND_1 });
    expect(res.status).toBe(201);
    expect(res.body.audience.offerId).toBeNull();
  });

  it("400s an offerId that is not a uuid rather than storing junk", async () => {
    const res = await create({
      name: "Bad offer",
      brandId: BRAND_1,
      offerId: "offer-1",
    });
    expect(res.status).toBe(400);
  });

  it("does NOT call out to brand-service to validate the offer (a scope, like brandId)", async () => {
    // No downstream fetch is stubbed in this file: a create carrying an unknown
    // offer id still succeeds, which is the whole point — an offer id decides
    // nothing about who a serve reaches, so there is nothing to validate.
    const res = await create({
      name: "Unknown offer",
      brandId: BRAND_1,
      offerId: "00000000-0000-4000-8000-0000000000ff",
    });
    expect(res.status).toBe(201);
  });

  it("refuses to re-scope an existing audience to another offer (immutable)", async () => {
    const created = await create({
      name: "Immutable",
      brandId: BRAND_1,
      offerId: OFFER_1,
    });
    const patch = await request(app)
      .patch(`/orgs/audiences/${created.body.audience.id}`)
      .set(headers())
      .send({ offerId: OFFER_2 });
    expect(patch.status).toBe(400);

    const [row] = await db
      .select()
      .from(audiences)
      .where(eq(audiences.id, created.body.audience.id));
    expect(row.offerId).toBe(OFFER_1);
  });
});

// AC 2 — listing narrows to one offer; listing without one is unchanged.
describe("GET /orgs/audiences?offerId=", () => {
  beforeEach(async () => {
    await create({ name: "Offer 1 A", brandId: BRAND_1, offerId: OFFER_1 });
    await create({ name: "Offer 1 B", brandId: BRAND_1, offerId: OFFER_1 });
    await create({ name: "Offer 2 A", brandId: BRAND_1, offerId: OFFER_2 });
    await create({ name: "Brand-wide", brandId: BRAND_1 });
    await create({ name: "Other brand", brandId: BRAND_2, offerId: OFFER_1 });
  });

  it("returns only that offer's audiences", async () => {
    const res = await request(app)
      .get(`/orgs/audiences?brandId=${BRAND_1}&offerId=${OFFER_1}`)
      .set(headers());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.audiences.map((a: { name: string }) => a.name).sort()).toEqual([
      "Offer 1 A",
      "Offer 1 B",
    ]);
  });

  it("narrows across brands too — offerId alone stays org-scoped", async () => {
    const res = await request(app)
      .get(`/orgs/audiences?offerId=${OFFER_1}`)
      .set(headers());
    expect(res.body.total).toBe(3);
  });

  it("without offerId returns every audience of the brand, offer-less included", async () => {
    const res = await request(app)
      .get(`/orgs/audiences?brandId=${BRAND_1}`)
      .set(headers());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.audiences.map((a: { name: string }) => a.name).sort()).toEqual([
      "Brand-wide",
      "Offer 1 A",
      "Offer 1 B",
      "Offer 2 A",
    ]);
  });

  it("400s a non-uuid offerId", async () => {
    const res = await request(app)
      .get("/orgs/audiences?offerId=nope")
      .set(headers());
    expect(res.status).toBe(400);
  });
});

// AC 3 + AC 4 — name uniqueness is per (org, brand, offer).
describe("Audience name uniqueness is per (org, brand, offer)", () => {
  it("allows the same name under the same brand for two DIFFERENT offers", async () => {
    const first = await create({
      name: "US SaaS founders",
      brandId: BRAND_1,
      offerId: OFFER_1,
    });
    const second = await create({
      name: "US SaaS founders",
      brandId: BRAND_1,
      offerId: OFFER_2,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.audience.id).not.toBe(first.body.audience.id);
  });

  it("still 409s the same name under the same brand and the SAME offer", async () => {
    const first = await create({
      name: "US SaaS founders",
      brandId: BRAND_1,
      offerId: OFFER_1,
    });
    expect(first.status).toBe(201);

    const dupe = await create({
      name: "us saas FOUNDERS", // case-insensitive, as before
      brandId: BRAND_1,
      offerId: OFFER_1,
    });
    expect(dupe.status).toBe(409);
  });

  it("still 409s two offer-LESS audiences sharing a name (unchanged)", async () => {
    expect((await create({ name: "Brand wide", brandId: BRAND_1 })).status).toBe(
      201
    );
    expect((await create({ name: "brand WIDE", brandId: BRAND_1 })).status).toBe(
      409
    );
  });

  it("lets an offer-scoped audience share a name with the brand's offer-less one", async () => {
    expect((await create({ name: "Shared", brandId: BRAND_1 })).status).toBe(201);
    expect(
      (await create({ name: "Shared", brandId: BRAND_1, offerId: OFFER_1 }))
        .status
    ).toBe(201);
  });

  it("still 409s a PATCH rename onto a sibling of the same offer", async () => {
    await create({ name: "Taken", brandId: BRAND_1, offerId: OFFER_1 });
    const other = await create({
      name: "Free",
      brandId: BRAND_1,
      offerId: OFFER_1,
    });
    const patch = await request(app)
      .patch(`/orgs/audiences/${other.body.audience.id}`)
      .set(headers())
      .send({ name: "Taken" });
    expect(patch.status).toBe(409);
  });

  it("allows a PATCH rename onto a name taken under a DIFFERENT offer", async () => {
    await create({ name: "Taken", brandId: BRAND_1, offerId: OFFER_1 });
    const other = await create({
      name: "Free",
      brandId: BRAND_1,
      offerId: OFFER_2,
    });
    const patch = await request(app)
      .patch(`/orgs/audiences/${other.body.audience.id}`)
      .set(headers())
      .send({ name: "Taken" });
    expect(patch.status).toBe(200);
    expect(patch.body.audience.name).toBe("Taken");
  });
});
