import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { clientPersonRequest, triggeredByClientPerson } from "../../src/lib/list-trigger.js";

describe("a client's person triggered this list build (OUTCOME-PERFORMER-1106)", () => {
  it("a marked route's async work (and what it starts) reads person; an unmarked one, a timer, does not", async () => {
    const app = express();
    app.post("/marked", clientPersonRequest, async (_req, res) => {
      await new Promise((r) => setTimeout(r, 5));
      const started = await Promise.resolve().then(() => triggeredByClientPerson());
      res.json({ person: triggeredByClientPerson(), started });
    });
    app.post("/plain", async (_req, res) => {
      await new Promise((r) => setTimeout(r, 5));
      res.json({ person: triggeredByClientPerson() });
    });
    expect((await request(app).post("/marked")).body).toEqual({ person: true, started: true });
    expect((await request(app).post("/plain")).body).toEqual({ person: false });
    expect(triggeredByClientPerson()).toBe(false);
  });
});
