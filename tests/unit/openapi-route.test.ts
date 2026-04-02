import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";

const app = createTestApp();

describe("GET /openapi.json", () => {
  it("returns the OpenAPI spec as JSON", async () => {
    const res = await request(app).get("/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("openapi");
    expect(res.body).toHaveProperty("info");
    expect(res.body).toHaveProperty("paths");
  });

  it("returns content-type application/json", async () => {
    const res = await request(app).get("/openapi.json");

    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
