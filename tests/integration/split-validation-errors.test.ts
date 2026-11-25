// An outside caller (often an AI agent) reads the FIRST line of a 400: on the
// three split routes it names every offending field and what was expected, never
// Zod's JSON dump; `issues` carries the same facts structured (AGENT-SIGNUP-UX-1125).
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { closeDb } from "../helpers/test-db.js";

const app = createTestApp();

afterAll(async () => {
  await closeDb();
});

function post(path: string, body: unknown) {
  return request(app).post(path).set(getAuthHeaders()).send(body as object);
}

function expectFieldError(res: request.Response, fields: string[]) {
  expect(res.status).toBe(400);
  expect(typeof res.body.error).toBe("string");
  // One line, never a JSON array dump.
  expect(res.body.error).not.toContain("\n");
  expect(res.body.error.trim().startsWith("[")).toBe(false);
  for (const f of fields) expect(res.body.error).toContain(`${f}: `);
  expect(Array.isArray(res.body.issues)).toBe(true);
  expect(res.body.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(fields));
  for (const i of res.body.issues) {
    expect(typeof i.message).toBe("string");
    expect(typeof i.code).toBe("string");
  }
}

describe("split routes: 400 names the field and the expectation", () => {
  it("/orgs/audiences/split", async () => {
    const res = await post("/orgs/audiences/split", { brandId: "not-a-uuid" });
    expectFieldError(res, ["brandId", "targetAudience"]);
    expect(res.body.error).toMatch(/brandId: Invalid UUID/);
  });

  it("/orgs/audiences/split/estimate", async () => {
    const res = await post("/orgs/audiences/split/estimate", {
      brandId: "00000000-0000-4000-8000-0000000000b1",
      offerId: "nope",
      segments: [{ name: "", description: "Founders." }],
    });
    expectFieldError(res, ["offerId", "segments.0.name"]);
    expect(res.body.error).toMatch(/offerId: Invalid UUID/);
  });

  it("/orgs/audiences/split/estimate with more than 8 segments", async () => {
    const segments = Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, description: "Founders." }));
    const res = await post("/orgs/audiences/split/estimate", {
      brandId: "00000000-0000-4000-8000-0000000000b1",
      segments,
    });
    expectFieldError(res, ["segments"]);
    expect(res.body.error).toMatch(/segments: .*8/);
  });

  it("/orgs/audiences/split/confirm", async () => {
    const res = await post("/orgs/audiences/split/confirm", {
      brandId: "00000000-0000-4000-8000-0000000000b1",
      segments: [],
    });
    expectFieldError(res, ["offerId", "segments"]);
  });

  it("an empty body names the body", async () => {
    const res = await request(app)
      .post("/orgs/audiences/split/confirm")
      .set(getAuthHeaders())
      .set("content-type", "application/json")
      .send("[]");
    expectFieldError(res, ["body"]);
  });
});
