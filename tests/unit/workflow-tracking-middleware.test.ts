import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { requireApiKey, requireIdentity, getWorkflowTracking } from "../../src/middleware/auth.js";

function createApp() {
  const app = express();
  app.use(express.json());

  app.get(
    "/test",
    requireApiKey,
    requireIdentity,
    (req, res) => {
      const wt = getWorkflowTracking(res.locals);
      res.json({
        orgId: res.locals.orgId,
        campaignId: wt.campaignId ?? null,
        brandIds: wt.brandIds ?? null,
        workflowSlug: wt.workflowSlug ?? null,
        audienceId: wt.audienceId ?? null,
      });
    }
  );

  return app;
}

describe("workflow tracking middleware", () => {
  const app = createApp();
  const baseHeaders = {
    "X-API-Key": process.env.HUMAN_SERVICE_API_KEY || "test-api-key",
    "x-org-id": "00000000-0000-0000-0000-000000000001",
    "x-user-id": "00000000-0000-0000-0000-000000000002",
    "x-run-id": "00000000-0000-0000-0000-000000000003",
  };

  it("extracts workflow tracking headers when present (single brand)", async () => {
    const res = await request(app)
      .get("/test")
      .set({
        ...baseHeaders,
        "x-campaign-id": "camp-abc",
        "x-brand-id": "brand-xyz",
        "x-workflow-slug": "my-workflow",
      });

    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe("camp-abc");
    expect(res.body.brandIds).toEqual(["brand-xyz"]);
    expect(res.body.workflowSlug).toBe("my-workflow");
  });

  it("parses multi-brand CSV x-brand-id header", async () => {
    const res = await request(app)
      .get("/test")
      .set({
        ...baseHeaders,
        "x-brand-id": "brand-1,brand-2,brand-3",
      });

    expect(res.status).toBe(200);
    expect(res.body.brandIds).toEqual(["brand-1", "brand-2", "brand-3"]);
  });

  it("trims whitespace in CSV brand IDs", async () => {
    const res = await request(app)
      .get("/test")
      .set({
        ...baseHeaders,
        "x-brand-id": " brand-1 , brand-2 , brand-3 ",
      });

    expect(res.status).toBe(200);
    expect(res.body.brandIds).toEqual(["brand-1", "brand-2", "brand-3"]);
  });

  it("extracts x-audience-id into the tracking block when present", async () => {
    const res = await request(app)
      .get("/test")
      .set({
        ...baseHeaders,
        "x-audience-id": "aud-123",
      });

    expect(res.status).toBe(200);
    expect(res.body.audienceId).toBe("aud-123");
  });

  it("returns null for workflow tracking headers when absent", async () => {
    const res = await request(app)
      .get("/test")
      .set(baseHeaders);

    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBeNull();
    expect(res.body.brandIds).toBeNull();
    expect(res.body.workflowSlug).toBeNull();
    expect(res.body.audienceId).toBeNull();
  });

  it("handles partial workflow tracking headers", async () => {
    const res = await request(app)
      .get("/test")
      .set({
        ...baseHeaders,
        "x-campaign-id": "camp-only",
      });

    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe("camp-only");
    expect(res.body.brandIds).toBeNull();
    expect(res.body.workflowSlug).toBeNull();
  });

  it("still requires identity headers — workflow headers alone are not enough", async () => {
    const res = await request(app)
      .get("/test")
      .set({
        "X-API-Key": baseHeaders["X-API-Key"],
        "x-campaign-id": "camp-abc",
      });

    expect(res.status).toBe(400);
  });

  // ── Malformed x-org-id: must 400/normalize, NEVER crash the process ──────────
  // Regression: a doubled x-org-id header arrives comma-joined ("<uuid>,") and used
  // to reach a `uuid` SQL param → Postgres 22P02 → unhandled rejection → process
  // crash-loop → human-service DOWN for every consumer.

  it("tolerates a doubled x-org-id header (dedups '<uuid>,' to the single value)", async () => {
    const res = await request(app)
      .get("/test")
      .set({ ...baseHeaders, "x-org-id": `${baseHeaders["x-org-id"]},` });

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(baseHeaders["x-org-id"]);
  });

  it("tolerates a doubled x-org-id header with the same value repeated", async () => {
    const res = await request(app)
      .get("/test")
      .set({ ...baseHeaders, "x-org-id": `${baseHeaders["x-org-id"]},${baseHeaders["x-org-id"]}` });

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(baseHeaders["x-org-id"]);
  });

  it("rejects an ambiguous x-org-id with two DISTINCT values → 400 (not a crash)", async () => {
    const res = await request(app)
      .get("/test")
      .set({
        ...baseHeaders,
        "x-org-id": "00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-0000000000ff",
      });

    expect(res.status).toBe(400);
  });

  it("rejects a non-UUID x-org-id → 400 (not a crash)", async () => {
    const res = await request(app)
      .get("/test")
      .set({ ...baseHeaders, "x-org-id": "not-a-uuid" });

    expect(res.status).toBe(400);
  });
});
