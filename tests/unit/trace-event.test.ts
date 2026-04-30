import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

describe("traceEvent", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({ ok: true });
    process.env.RUNS_SERVICE_URL = "http://runs:3000";
    process.env.RUNS_SERVICE_API_KEY = "runs-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /v1/runs/{runId}/events with correct body", async () => {
    const { traceEvent } = await import("../../src/lib/trace-event.js");

    await traceEvent(
      "run-123",
      {
        service: "human-service",
        event: "extraction-started",
      },
      {}
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://runs:3000/v1/runs/run-123/events");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body);
    expect(body.service).toBe("human-service");
    expect(body.event).toBe("extraction-started");
  });

  it("forwards all identity headers", async () => {
    const { traceEvent } = await import("../../src/lib/trace-event.js");

    await traceEvent(
      "run-123",
      { service: "human-service", event: "test" },
      {
        "x-org-id": "org-1",
        "x-user-id": "user-1",
        "x-brand-id": "brand-1",
        "x-campaign-id": "camp-1",
        "x-workflow-slug": "extract-methodology",
        "x-feature-slug": "feature-1",
      }
    );

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["x-org-id"]).toBe("org-1");
    expect(opts.headers["x-user-id"]).toBe("user-1");
    expect(opts.headers["x-brand-id"]).toBe("brand-1");
    expect(opts.headers["x-campaign-id"]).toBe("camp-1");
    expect(opts.headers["x-workflow-slug"]).toBe("extract-methodology");
    expect(opts.headers["x-feature-slug"]).toBe("feature-1");
  });

  it("skips when RUNS_SERVICE_URL is missing", async () => {
    process.env.RUNS_SERVICE_URL = "";
    const { traceEvent } = await import("../../src/lib/trace-event.js");

    await traceEvent(
      "run-123",
      { service: "human-service", event: "test" },
      {}
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws on fetch error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    const { traceEvent } = await import("../../src/lib/trace-event.js");

    await expect(
      traceEvent(
        "run-123",
        { service: "human-service", event: "test" },
        {}
      )
    ).resolves.toBeUndefined();
  });

  it("passes optional data, level, and detail fields", async () => {
    const { traceEvent } = await import("../../src/lib/trace-event.js");

    await traceEvent(
      "run-456",
      {
        service: "human-service",
        event: "pages-scraped",
        detail: "Scraped 5 pages",
        level: "warn",
        data: { pageCount: 5, urls: ["https://example.com"] },
      },
      {}
    );

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.detail).toBe("Scraped 5 pages");
    expect(body.level).toBe("warn");
    expect(body.data).toEqual({ pageCount: 5, urls: ["https://example.com"] });
  });

  it("omits identity headers that are not present", async () => {
    const { traceEvent } = await import("../../src/lib/trace-event.js");

    await traceEvent(
      "run-123",
      { service: "human-service", event: "test" },
      { "x-org-id": "org-1" }
    );

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["x-org-id"]).toBe("org-1");
    expect(opts.headers["x-user-id"]).toBeUndefined();
    expect(opts.headers["x-brand-id"]).toBeUndefined();
    expect(opts.headers["x-campaign-id"]).toBeUndefined();
    expect(opts.headers["x-workflow-slug"]).toBeUndefined();
    expect(opts.headers["x-feature-slug"]).toBeUndefined();
  });
});
