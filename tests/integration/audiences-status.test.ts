import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";

const app = createTestApp();

const ORG = "a0000000-0000-4000-8000-000000000001";
const BRAND_A = "b0000000-0000-4000-8000-00000000000a";
const BRAND_B = "b0000000-0000-4000-8000-00000000000b";

const headers = {
  "X-API-Key": "test-api-key",
  "Content-Type": "application/json",
  "x-org-id": ORG,
};

async function seedAudience(overrides: Partial<typeof audiences.$inferInsert> = {}) {
  const [row] = await db
    .insert(audiences)
    .values({
      orgId: ORG,
      brandId: BRAND_A,
      name: `aud-${Math.random().toString(36).slice(2)}`,
      filters: { titles: ["CEO"] },
      ...overrides,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("Audience status lifecycle", () => {
  it("creates an audience with status=active and source=null by default", async () => {
    const res = await request(app)
      .post("/orgs/audiences")
      .set(headers)
      .send({ name: "Founders", brandId: BRAND_A, filters: { titles: ["CEO"] } });

    expect(res.status).toBe(201);
    expect(res.body.audience.status).toBe("active");
    expect(res.body.audience.source).toBeNull();
  });

  it("GET /orgs/audiences includes status on every audience", async () => {
    await seedAudience({ status: "active" });
    const res = await request(app).get("/orgs/audiences").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.audiences.length).toBe(1);
    expect(res.body.audiences[0].status).toBe("active");
  });

  it("GET /orgs/audiences?status=active returns only active audiences", async () => {
    await seedAudience({ name: "a-active", status: "active" });
    await seedAudience({ name: "a-paused", status: "paused" });
    await seedAudience({ name: "a-archived", status: "archived" });

    const res = await request(app)
      .get("/orgs/audiences?status=active")
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.audiences.map((a: { name: string }) => a.name)).toEqual([
      "a-active",
    ]);
    expect(res.body.total).toBe(1);
  });

  it("PATCH /orgs/audiences/:id/status mutates only status", async () => {
    const aud = await seedAudience({ status: "active" });
    const res = await request(app)
      .patch(`/orgs/audiences/${aud.id}/status`)
      .set(headers)
      .send({ status: "paused" });

    expect(res.status).toBe(200);
    expect(res.body.audience.status).toBe("paused");
    // name + filters untouched
    expect(res.body.audience.name).toBe(aud.name);
    expect(res.body.audience.filters).toEqual({ titles: ["CEO"] });
  });

  it("PATCH /orgs/audiences/:id/status rejects an invalid status (400)", async () => {
    const aud = await seedAudience();
    const res = await request(app)
      .patch(`/orgs/audiences/${aud.id}/status`)
      .set(headers)
      .send({ status: "deleted" });
    expect(res.status).toBe(400);
  });

  it("PATCH /orgs/audiences/:id/status on a missing id returns 404", async () => {
    const res = await request(app)
      .patch("/orgs/audiences/c0000000-0000-4000-8000-0000000000ff/status")
      .set(headers)
      .send({ status: "paused" });
    expect(res.status).toBe(404);
  });

  it("PATCH /orgs/audiences/:id rejects filters/brandId edits (immutable, 400)", async () => {
    const aud = await seedAudience();
    const resFilters = await request(app)
      .patch(`/orgs/audiences/${aud.id}`)
      .set(headers)
      .send({ filters: { titles: ["CTO"] } });
    expect(resFilters.status).toBe(400);

    const resBrand = await request(app)
      .patch(`/orgs/audiences/${aud.id}`)
      .set(headers)
      .send({ brandId: BRAND_B });
    expect(resBrand.status).toBe(400);
  });

  it("PATCH /orgs/audiences/:id still edits metadata (name / nlPrompt)", async () => {
    const aud = await seedAudience();
    const res = await request(app)
      .patch(`/orgs/audiences/${aud.id}`)
      .set(headers)
      .send({ name: "Renamed", nlPrompt: "founders in FR" });
    expect(res.status).toBe(200);
    expect(res.body.audience.name).toBe("Renamed");
    expect(res.body.audience.nlPrompt).toBe("founders in FR");
  });

  it("POST /orgs/audiences with a duplicate name for the same brand returns 409", async () => {
    await request(app)
      .post("/orgs/audiences")
      .set(headers)
      .send({ name: "Dup", brandId: BRAND_A });

    const res = await request(app)
      .post("/orgs/audiences")
      .set(headers)
      .send({ name: "dup", brandId: BRAND_A }); // case-insensitive collision
    expect(res.status).toBe(409);
  });

  it("allows the same name under a different brand", async () => {
    await request(app)
      .post("/orgs/audiences")
      .set(headers)
      .send({ name: "Shared", brandId: BRAND_A });
    const res = await request(app)
      .post("/orgs/audiences")
      .set(headers)
      .send({ name: "Shared", brandId: BRAND_B });
    expect(res.status).toBe(201);
  });

  it("DELETE /orgs/audiences/:id is a hard delete (archive is separate)", async () => {
    const aud = await seedAudience({ status: "archived" });
    const del = await request(app)
      .delete(`/orgs/audiences/${aud.id}`)
      .set(headers);
    expect(del.status).toBe(204);

    const get = await request(app)
      .get(`/orgs/audiences/${aud.id}`)
      .set(headers);
    expect(get.status).toBe(404);
  });
});
