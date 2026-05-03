import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const app = createTestApp();
const headers = getAuthHeaders();

const ORG_A = "00000000-0000-0000-0000-000000000001";
const ORG_B = "00000000-0000-0000-0000-000000000099";

const orgBHeaders = {
  ...headers,
  "x-org-id": ORG_B,
  "x-user-id": "00000000-0000-0000-0000-000000000098",
};

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

async function createList(overrides: Record<string, unknown> = {}) {
  return request(app)
    .post("/orgs/lists")
    .set(headers)
    .send({ name: "Sales newsletter", ...overrides });
}

describe("POST /orgs/lists", () => {
  it("creates a list (brand_id null)", async () => {
    const res = await createList();
    expect(res.status).toBe(201);
    expect(res.body.list.id).toBeDefined();
    expect(res.body.list.name).toBe("Sales newsletter");
    expect(res.body.list.brandId).toBeNull();
    expect(res.body.list.orgId).toBe(ORG_A);
    expect(res.body.list.createdByUserId).toBe(headers["x-user-id"]);
  });

  it("creates a list with brand_id", async () => {
    const brandId = "550e8400-e29b-41d4-a716-446655440000";
    const res = await createList({ brandId });
    expect(res.status).toBe(201);
    expect(res.body.list.brandId).toBe(brandId);
  });

  it("rejects missing name", async () => {
    const res = await request(app)
      .post("/orgs/lists")
      .set(headers)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/orgs/lists")
      .set({
        "Content-Type": "application/json",
        "x-org-id": ORG_A,
      })
      .send({ name: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 400 without x-org-id", async () => {
    const res = await request(app)
      .post("/orgs/lists")
      .set({ "X-API-Key": "test-api-key", "Content-Type": "application/json" })
      .send({ name: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });
});

describe("GET /orgs/lists", () => {
  it("lists with pagination + total", async () => {
    await createList({ name: "list-1" });
    await createList({ name: "list-2" });

    const res = await request(app).get("/orgs/lists").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.lists).toHaveLength(2);
    expect(res.body.lists.map((l: { name: string }) => l.name)).toEqual([
      "list-1",
      "list-2",
    ]);
  });

  it("isolates lists between orgs", async () => {
    await createList({ name: "org-A list" });

    await request(app)
      .post("/orgs/lists")
      .set(orgBHeaders)
      .send({ name: "org-B list" });

    const orgARes = await request(app).get("/orgs/lists").set(headers);
    const orgBRes = await request(app).get("/orgs/lists").set(orgBHeaders);

    expect(orgARes.body.lists).toHaveLength(1);
    expect(orgARes.body.lists[0].name).toBe("org-A list");
    expect(orgBRes.body.lists).toHaveLength(1);
    expect(orgBRes.body.lists[0].name).toBe("org-B list");
  });
});

describe("GET /orgs/lists/:id", () => {
  it("returns the list", async () => {
    const created = await createList();
    const res = await request(app)
      .get(`/orgs/lists/${created.body.list.id}`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.list.id).toBe(created.body.list.id);
  });

  it("returns 404 when list belongs to another org", async () => {
    const created = await createList();
    const res = await request(app)
      .get(`/orgs/lists/${created.body.list.id}`)
      .set(orgBHeaders);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /orgs/lists/:id", () => {
  it("renames a list and bumps updated_at", async () => {
    const created = await createList({ name: "old name" });
    await new Promise((r) => setTimeout(r, 5));

    const res = await request(app)
      .patch(`/orgs/lists/${created.body.list.id}`)
      .set(headers)
      .send({ name: "new name" });

    expect(res.status).toBe(200);
    expect(res.body.list.name).toBe("new name");
    expect(new Date(res.body.list.updatedAt).getTime()).toBeGreaterThan(
      new Date(created.body.list.updatedAt).getTime()
    );
  });

  it("returns 404 when patching another org's list", async () => {
    const created = await createList();
    const res = await request(app)
      .patch(`/orgs/lists/${created.body.list.id}`)
      .set(orgBHeaders)
      .send({ name: "hijack" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /orgs/lists/:id", () => {
  it("deletes a list and cascades members", async () => {
    const created = await createList();
    const listId = created.body.list.id;

    await request(app)
      .post(`/orgs/lists/${listId}/members`)
      .set(headers)
      .send({
        members: [
          { sourceResourceId: "people/c1" },
          { sourceResourceId: "people/c2" },
        ],
      });

    const del = await request(app)
      .delete(`/orgs/lists/${listId}`)
      .set(headers);
    expect(del.status).toBe(204);

    const fetchAfter = await request(app)
      .get(`/orgs/lists/${listId}`)
      .set(headers);
    expect(fetchAfter.status).toBe(404);

    const members = await request(app)
      .get(`/orgs/lists/${listId}/members`)
      .set(headers);
    // Members endpoint also 404s because parent list is gone
    expect(members.status).toBe(404);
  });
});

describe("POST /orgs/lists/:id/members", () => {
  it("adds 3 members and is idempotent on re-add", async () => {
    const created = await createList();
    const listId = created.body.list.id;
    const body = {
      members: [
        { sourceResourceId: "people/c1" },
        { sourceResourceId: "people/c2" },
        { sourceResourceId: "people/c3" },
      ],
    };

    const first = await request(app)
      .post(`/orgs/lists/${listId}/members`)
      .set(headers)
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ added: 3, skipped: 0 });

    const second = await request(app)
      .post(`/orgs/lists/${listId}/members`)
      .set(headers)
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ added: 0, skipped: 3 });
  });

  it("partial overlap returns split counts", async () => {
    const created = await createList();
    const listId = created.body.list.id;

    await request(app)
      .post(`/orgs/lists/${listId}/members`)
      .set(headers)
      .send({ members: [{ sourceResourceId: "people/c1" }] });

    const res = await request(app)
      .post(`/orgs/lists/${listId}/members`)
      .set(headers)
      .send({
        members: [
          { sourceResourceId: "people/c1" }, // dup
          { sourceResourceId: "people/c2" },
          { sourceResourceId: "people/c3" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ added: 2, skipped: 1 });
  });

  it("404 when posting to another org's list", async () => {
    const created = await createList();
    const res = await request(app)
      .post(`/orgs/lists/${created.body.list.id}/members`)
      .set(orgBHeaders)
      .send({ members: [{ sourceResourceId: "people/c1" }] });
    expect(res.status).toBe(404);
  });
});

describe("GET /orgs/lists/:id/members", () => {
  it("returns members with total", async () => {
    const created = await createList();
    const listId = created.body.list.id;

    await request(app)
      .post(`/orgs/lists/${listId}/members`)
      .set(headers)
      .send({
        members: [
          { sourceResourceId: "people/c1" },
          { sourceResourceId: "people/c2" },
          { sourceResourceId: "people/c3" },
        ],
      });

    const res = await request(app)
      .get(`/orgs/lists/${listId}/members`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.members).toHaveLength(3);
    expect(res.body.members[0].sourceService).toBe("google-service");
  });
});

describe("DELETE /orgs/lists/:id/members", () => {
  it("removes existing members and counts not-found", async () => {
    const created = await createList();
    const listId = created.body.list.id;

    await request(app)
      .post(`/orgs/lists/${listId}/members`)
      .set(headers)
      .send({
        members: [
          { sourceResourceId: "people/c1" },
          { sourceResourceId: "people/c2" },
          { sourceResourceId: "people/c3" },
        ],
      });

    const remove = await request(app)
      .delete(`/orgs/lists/${listId}/members`)
      .set(headers)
      .send({
        members: [
          { sourceResourceId: "people/c1" },
          { sourceResourceId: "people/c2" },
        ],
      });
    expect(remove.status).toBe(200);
    expect(remove.body).toEqual({ removed: 2, notFound: 0 });

    const removeMissing = await request(app)
      .delete(`/orgs/lists/${listId}/members`)
      .set(headers)
      .send({ members: [{ sourceResourceId: "people/never-existed" }] });
    expect(removeMissing.status).toBe(200);
    expect(removeMissing.body).toEqual({ removed: 0, notFound: 1 });
  });
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
