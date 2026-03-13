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
        brandId: wt.brandId ?? null,
        workflowName: wt.workflowName ?? null,
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

  it("extracts workflow tracking headers when present", async () => {
    const res = await request(app)
      .get("/test")
      .set({
        ...baseHeaders,
        "x-campaign-id": "camp-abc",
        "x-brand-id": "brand-xyz",
        "x-workflow-name": "my-workflow",
      });

    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe("camp-abc");
    expect(res.body.brandId).toBe("brand-xyz");
    expect(res.body.workflowName).toBe("my-workflow");
  });

  it("returns null for workflow tracking headers when absent", async () => {
    const res = await request(app)
      .get("/test")
      .set(baseHeaders);

    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBeNull();
    expect(res.body.brandId).toBeNull();
    expect(res.body.workflowName).toBeNull();
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
    expect(res.body.brandId).toBeNull();
    expect(res.body.workflowName).toBeNull();
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
