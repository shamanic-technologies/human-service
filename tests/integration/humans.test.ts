import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertHuman,
} from "../helpers/test-db.js";

const app = createTestApp();
const headers = getAuthHeaders();

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /humans", () => {
  it("creates a new human", async () => {
    const res = await request(app).post("/humans").set(headers).send({
      name: "Jane Expert",
      slug: "jane-expert",
      urls: ["https://jane.example.com"],
    });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(true);
    expect(res.body.human.name).toBe("Jane Expert");
    expect(res.body.human.slug).toBe("jane-expert");
    expect(res.body.human.id).toBeDefined();
  });

  it("updates an existing human with the same slug", async () => {
    // First create
    await request(app).post("/humans").set(headers).send({
      name: "Jane Expert",
      slug: "jane-expert",
      urls: ["https://jane.example.com"],
    });

    // Then update
    const res = await request(app).post("/humans").set(headers).send({
      name: "Jane Expert Updated",
      slug: "jane-expert",
      urls: ["https://jane.example.com", "https://jane.blog.com"],
      bio: "Updated bio",
    });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.human.name).toBe("Jane Expert Updated");
    expect(res.body.human.bio).toBe("Updated bio");
  });

  it("rejects invalid slug format", async () => {
    const res = await request(app).post("/humans").set(headers).send({
      name: "Jane Expert",
      slug: "INVALID SLUG!",
      urls: ["https://jane.example.com"],
    });

    expect(res.status).toBe(400);
  });

  it("rejects missing required fields", async () => {
    const res = await request(app).post("/humans").set(headers).send({
      // missing name, slug, urls
    });

    expect(res.status).toBe(400);
  });

  it("rejects empty urls array", async () => {
    const res = await request(app).post("/humans").set(headers).send({
      name: "Jane Expert",
      slug: "jane-expert",
      urls: [],
    });

    expect(res.status).toBe(400);
  });

  it("returns 401 without API key", async () => {
    const res = await request(app).post("/humans").send({
      name: "Jane Expert",
      slug: "jane-expert",
      urls: ["https://jane.example.com"],
    });

    expect(res.status).toBe(401);
  });

  it("returns 400 without identity headers", async () => {
    const res = await request(app)
      .post("/humans")
      .set({ "X-API-Key": "test-api-key", "Content-Type": "application/json" })
      .send({
        name: "Jane Expert",
        slug: "jane-expert",
        urls: ["https://jane.example.com"],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });
});

describe("GET /humans", () => {
  it("lists humans for an org", async () => {
    // Create two humans
    await request(app).post("/humans").set(headers).send({
      name: "Jane Expert",
      slug: "jane-expert",
      urls: ["https://jane.example.com"],
    });

    await request(app).post("/humans").set(headers).send({
      name: "John Guru",
      slug: "john-guru",
      urls: ["https://john.example.com"],
    });

    const res = await request(app).get("/humans").set(headers);

    expect(res.status).toBe(200);
    expect(res.body.humans).toHaveLength(2);
  });

  it("returns empty array for unknown org", async () => {
    const res = await request(app)
      .get("/humans")
      .set({
        ...headers,
        "x-org-id": "00000000-0000-0000-0000-999999999999",
      });

    expect(res.status).toBe(200);
    expect(res.body.humans).toEqual([]);
  });

  it("returns 400 without identity headers", async () => {
    const res = await request(app)
      .get("/humans")
      .set({ "X-API-Key": "test-api-key" });

    expect(res.status).toBe(400);
  });

  it("isolates humans between orgs", async () => {
    await request(app).post("/humans").set(headers).send({
      name: "Jane Expert",
      slug: "jane-expert",
      urls: ["https://jane.example.com"],
    });

    const org2Headers = {
      ...headers,
      "x-org-id": "00000000-0000-0000-0000-000000000099",
      "x-user-id": "00000000-0000-0000-0000-000000000098",
    };

    await request(app).post("/humans").set(org2Headers).send({
      name: "John Guru",
      slug: "john-guru",
      urls: ["https://john.example.com"],
    });

    const org1 = await request(app).get("/humans").set(headers);
    const org2 = await request(app).get("/humans").set(org2Headers);

    expect(org1.body.humans).toHaveLength(1);
    expect(org1.body.humans[0].name).toBe("Jane Expert");
    expect(org2.body.humans).toHaveLength(1);
    expect(org2.body.humans[0].name).toBe("John Guru");
  });
});

describe("GET /humans/:id", () => {
  it("returns a human by ID", async () => {
    const createRes = await request(app).post("/humans").set(headers).send({
      name: "Jane Expert",
      slug: "jane-expert",
      urls: ["https://jane.example.com"],
      bio: "Expert in testing",
      expertise: ["testing", "vitest"],
    });

    const humanId = createRes.body.human.id;

    const res = await request(app)
      .get(`/humans/${humanId}`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.human.id).toBe(humanId);
    expect(res.body.human.name).toBe("Jane Expert");
    expect(res.body.human.bio).toBe("Expert in testing");
    expect(res.body.human.expertise).toEqual(["testing", "vitest"]);
  });

  it("returns 404 for non-existent ID", async () => {
    const res = await request(app)
      .get("/humans/00000000-0000-0000-0000-000000000000")
      .set(headers);

    expect(res.status).toBe(404);
  });
});
