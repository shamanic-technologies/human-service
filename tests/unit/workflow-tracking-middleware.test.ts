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

  it("returns null for workflow tracking headers when absent", async () => {
    const res = await request(app)
      .get("/test")
      .set(baseHeaders);

    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBeNull();
    expect(res.body.brandIds).toBeNull();
    expect(res.body.workflowSlug).toBeNull();
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
});
