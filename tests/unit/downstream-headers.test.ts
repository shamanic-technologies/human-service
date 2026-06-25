import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Capture fetch calls for verification
const fetchSpy = vi.fn();

// Mock global fetch
vi.stubGlobal("fetch", fetchSpy);

describe("downstream service headers", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "run-123" }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runs-service", () => {
    it("createRun sends x-org-id, x-user-id, x-run-id headers", async () => {
      process.env.RUNS_SERVICE_URL = "http://runs:3000";
      process.env.RUNS_SERVICE_API_KEY = "runs-key";

      const { createRun } = await import("../../src/services/runs.js");

      await createRun({
        orgId: "org-1",
        userId: "user-1",
        parentRunId: "parent-run-1",
        taskName: "test-task",
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://runs:3000/v1/runs");
      expect(opts.headers["x-org-id"]).toBe("org-1");
      expect(opts.headers["x-user-id"]).toBe("user-1");
      expect(opts.headers["x-run-id"]).toBe("parent-run-1");
      expect(opts.headers["X-API-Key"]).toBe("runs-key");

      // orgId, userId, parentRunId should NOT be in the body
      const body = JSON.parse(opts.body);
      expect(body.orgId).toBeUndefined();
      expect(body.userId).toBeUndefined();
      expect(body.parentRunId).toBeUndefined();
      expect(body.serviceName).toBe("human-service");
      expect(body.taskName).toBe("test-task");
    });

    it("createRun omits x-run-id when no parentRunId", async () => {
      process.env.RUNS_SERVICE_URL = "http://runs:3000";
      process.env.RUNS_SERVICE_API_KEY = "runs-key";

      const { createRun } = await import("../../src/services/runs.js");

      await createRun({
        orgId: "org-1",
        userId: "user-1",
        taskName: "test-task",
      });

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers["x-org-id"]).toBe("org-1");
      expect(opts.headers["x-user-id"]).toBe("user-1");
      expect(opts.headers["x-run-id"]).toBeUndefined();
    });

    it("addCosts sends identity headers with runId as x-run-id", async () => {
      process.env.RUNS_SERVICE_URL = "http://runs:3000";
      process.env.RUNS_SERVICE_API_KEY = "runs-key";

      const { addCosts } = await import("../../src/services/runs.js");

      await addCosts(
        "run-abc",
        [{ costName: "tokens", costSource: "platform", quantity: 100 }],
        { orgId: "org-1", userId: "user-1" }
      );

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://runs:3000/v1/runs/run-abc/costs");
      expect(opts.headers["x-org-id"]).toBe("org-1");
      expect(opts.headers["x-user-id"]).toBe("user-1");
      expect(opts.headers["x-run-id"]).toBe("run-abc");
    });

    it("completeRun sends identity headers with runId as x-run-id", async () => {
      process.env.RUNS_SERVICE_URL = "http://runs:3000";
      process.env.RUNS_SERVICE_API_KEY = "runs-key";

      const { completeRun } = await import("../../src/services/runs.js");

      await completeRun("run-abc", "completed", {
        orgId: "org-1",
        userId: "user-1",
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://runs:3000/v1/runs/run-abc");
      expect(opts.headers["x-org-id"]).toBe("org-1");
      expect(opts.headers["x-user-id"]).toBe("user-1");
      expect(opts.headers["x-run-id"]).toBe("run-abc");
    });
  });

  describe("key-service", () => {
    it("resolveApiKey sends x-org-id, x-user-id, x-run-id as headers (not query params)", async () => {
      process.env.KEY_SERVICE_URL = "http://keys:3001";
      process.env.KEY_SERVICE_API_KEY = "key-svc-key";

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ key: "sk-test", keySource: "platform" }),
      });

      const { resolveApiKey } = await import("../../src/services/keys.js");

      await resolveApiKey(
        "anthropic",
        { orgId: "org-1", userId: "user-1", runId: "run-1" },
        { method: "POST", path: "/test" }
      );

      const [url, opts] = fetchSpy.mock.calls[0];
      // URL should NOT have orgId/userId as query params
      expect(url).toBe("http://keys:3001/keys/anthropic/decrypt");
      expect(url).not.toContain("orgId=");
      expect(url).not.toContain("userId=");

      // Headers should contain identity
      expect(opts.headers["x-org-id"]).toBe("org-1");
      expect(opts.headers["x-user-id"]).toBe("user-1");
      expect(opts.headers["x-run-id"]).toBe("run-1");
      expect(opts.headers["x-caller-service"]).toBe("human");
    });
  });

  describe("scraping-service", () => {
    it("mapSiteUrls always sends identity headers (not conditional)", async () => {
      process.env.SCRAPING_SERVICE_URL = "http://scraping:3010";
      process.env.SCRAPING_SERVICE_API_KEY = "scrape-key";

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ urls: ["https://example.com/page1"] }),
      });

      const { mapSiteUrls } = await import("../../src/services/scraping.js");

      await mapSiteUrls("https://example.com", {
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
      });

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers["x-org-id"]).toBe("org-1");
      expect(opts.headers["x-user-id"]).toBe("user-1");
      expect(opts.headers["x-run-id"]).toBe("run-1");
    });

    it("scrapePage always sends identity headers (not conditional)", async () => {
      process.env.SCRAPING_SERVICE_URL = "http://scraping:3010";
      process.env.SCRAPING_SERVICE_API_KEY = "scrape-key";

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            rawMarkdown: "# Test",
            metadata: { title: "Test Page" },
          },
        }),
      });

      const { scrapePage } = await import("../../src/services/scraping.js");

      await scrapePage("https://example.com/page1", {
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
      });

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers["x-org-id"]).toBe("org-1");
      expect(opts.headers["x-user-id"]).toBe("user-1");
      expect(opts.headers["x-run-id"]).toBe("run-1");
    });
  });

  describe("workflow tracking headers forwarding", () => {
    it("createRun forwards x-campaign-id, x-brand-id, x-workflow-slug when provided", async () => {
      process.env.RUNS_SERVICE_URL = "http://runs:3000";
      process.env.RUNS_SERVICE_API_KEY = "runs-key";

      const { createRun } = await import("../../src/services/runs.js");

      await createRun({
        orgId: "org-1",
        userId: "user-1",
        parentRunId: "parent-run-1",
        taskName: "test-task",
        workflowTracking: {
          campaignId: "camp-123",
          brandIds: ["brand-456"],
          workflowSlug: "extract-methodology",
          audienceId: "aud-789",
        },
      });

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers["x-campaign-id"]).toBe("camp-123");
      expect(opts.headers["x-brand-id"]).toBe("brand-456");
      expect(opts.headers["x-workflow-slug"]).toBe("extract-methodology");
      expect(opts.headers["x-audience-id"]).toBe("aud-789");
    });

    it("createRun omits workflow tracking headers when not provided", async () => {
      process.env.RUNS_SERVICE_URL = "http://runs:3000";
      process.env.RUNS_SERVICE_API_KEY = "runs-key";

      const { createRun } = await import("../../src/services/runs.js");

      await createRun({
        orgId: "org-1",
        userId: "user-1",
        taskName: "test-task",
      });

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers["x-campaign-id"]).toBeUndefined();
      expect(opts.headers["x-brand-id"]).toBeUndefined();
      expect(opts.headers["x-workflow-slug"]).toBeUndefined();
    });

    it("mapSiteUrls forwards workflow tracking headers", async () => {
      process.env.SCRAPING_SERVICE_URL = "http://scraping:3010";
      process.env.SCRAPING_SERVICE_API_KEY = "scrape-key";

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ urls: ["https://example.com/page1"] }),
      });

      const { mapSiteUrls } = await import("../../src/services/scraping.js");

      await mapSiteUrls("https://example.com", {
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        workflowTracking: {
          campaignId: "camp-123",
          brandIds: ["brand-456"],
          workflowSlug: "extract-methodology",
        },
      });

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers["x-campaign-id"]).toBe("camp-123");
      expect(opts.headers["x-brand-id"]).toBe("brand-456");
      expect(opts.headers["x-workflow-slug"]).toBe("extract-methodology");
    });

    it("resolveApiKey forwards workflow tracking headers", async () => {
      process.env.KEY_SERVICE_URL = "http://keys:3001";
      process.env.KEY_SERVICE_API_KEY = "key-svc-key";

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ key: "sk-test", keySource: "platform" }),
      });

      const { resolveApiKey } = await import("../../src/services/keys.js");

      await resolveApiKey(
        "anthropic",
        {
          orgId: "org-1",
          userId: "user-1",
          runId: "run-1",
          workflowTracking: {
            campaignId: "camp-123",
            brandIds: ["brand-456"],
            workflowSlug: "extract-methodology",
          },
        },
        { method: "POST", path: "/test" }
      );

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers["x-campaign-id"]).toBe("camp-123");
      expect(opts.headers["x-brand-id"]).toBe("brand-456");
      expect(opts.headers["x-workflow-slug"]).toBe("extract-methodology");
    });

    it("addCosts forwards workflow tracking headers (incl x-audience-id)", async () => {
      process.env.RUNS_SERVICE_URL = "http://runs:3000";
      process.env.RUNS_SERVICE_API_KEY = "runs-key";

      const { addCosts } = await import("../../src/services/runs.js");

      await addCosts(
        "run-abc",
        [{ costName: "tokens", costSource: "platform", quantity: 100 }],
        {
          orgId: "org-1",
          userId: "user-1",
          workflowTracking: {
            campaignId: "camp-123",
            brandIds: ["brand-456"],
            workflowSlug: "extract-methodology",
            audienceId: "aud-789",
          },
        }
      );

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers["x-campaign-id"]).toBe("camp-123");
      expect(opts.headers["x-brand-id"]).toBe("brand-456");
      expect(opts.headers["x-workflow-slug"]).toBe("extract-methodology");
      expect(opts.headers["x-audience-id"]).toBe("aud-789");
    });
  });

  // chat-service is an internal sibling that OWNS the LLM / image cost; it needs
  // the campaign's priority audience to attribute that cost. The whole tracking
  // block (incl x-audience-id) is forwarded via the same builder.
  describe("chat-service", () => {
    it("completeJson forwards the tracking block (incl x-audience-id)", async () => {
      process.env.CHAT_SERVICE_URL = "http://chat:3020";
      process.env.CHAT_SERVICE_API_KEY = "chat-key";

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ json: { ok: true } }),
      });

      const { completeJson } = await import("../../src/lib/chat-client.js");

      await completeJson({
        message: "m",
        systemPrompt: "s",
        provider: "google",
        identity: {
          orgId: "org-1",
          userId: "user-1",
          runId: "run-1",
          workflowTracking: {
            campaignId: "camp-123",
            brandIds: ["brand-456"],
            workflowSlug: "audiences-suggest",
            audienceId: "aud-789",
          },
        },
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://chat:3020/complete");
      expect(opts.headers["x-org-id"]).toBe("org-1");
      expect(opts.headers["x-audience-id"]).toBe("aud-789");
      expect(opts.headers["x-campaign-id"]).toBe("camp-123");
    });

    it("completeJson emits no x-audience-id when the block is absent", async () => {
      process.env.CHAT_SERVICE_URL = "http://chat:3020";
      process.env.CHAT_SERVICE_API_KEY = "chat-key";

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ json: { ok: true } }),
      });

      const { completeJson } = await import("../../src/lib/chat-client.js");

      await completeJson({
        message: "m",
        systemPrompt: "s",
        provider: "google",
        identity: { orgId: "org-1", userId: "user-1" },
      });

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers["x-audience-id"]).toBeUndefined();
    });

    it("generateImage forwards x-audience-id", async () => {
      process.env.CHAT_SERVICE_URL = "http://chat:3020";
      process.env.CHAT_SERVICE_API_KEY = "chat-key";

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: "https://cdn.test/a.png", mimeType: "image/png" }),
      });

      const { generateImage } = await import("../../src/lib/chat-client.js");

      await generateImage({
        prompt: "draw",
        identity: {
          orgId: "org-1",
          userId: "user-1",
          workflowTracking: { audienceId: "aud-789" },
        },
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://chat:3020/orgs/images/generate");
      expect(opts.headers["x-audience-id"]).toBe("aud-789");
    });
  });
});
