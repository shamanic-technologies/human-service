import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
  BounceConfigError,
  BounceSourceError,
  findBouncedEmails,
} from "../../src/lib/instantly-bounces.js";

const identity = { orgId: "00000000-0000-0000-0000-000000000001" };
const fetchBefore = globalThis.fetch;
const fetchSpy = vi.fn();

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  process.env.INSTANTLY_SERVICE_URL = "http://instantly:8080";
  process.env.INSTANTLY_SERVICE_API_KEY = "instantly-key";
});

afterAll(() => {
  globalThis.fetch = fetchBefore;
});

describe("findBouncedEmails", () => {
  it("POSTs the normalized, deduped set and returns the bounced subset", async () => {
    fetchSpy.mockResolvedValue(
      ok({ bounced: [{ email: "Dead@acme.com", firstBouncedAt: "2026-09-01T00:00:00.000Z" }] })
    );

    const out = await findBouncedEmails(identity, [" Dead@ACME.com", "dead@acme.com", "alive@acme.com"]);

    expect([...out]).toEqual(["dead@acme.com"]);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://instantly:8080/internal/bounced-emails");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ emails: ["dead@acme.com", "alive@acme.com"] });
    expect(init.headers["X-API-Key"]).toBe("instantly-key");
  });

  it("asks nothing for an empty set", async () => {
    expect((await findBouncedEmails(identity, ["", "  "])).size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("splits at the producer's 1000-address cap", async () => {
    fetchSpy.mockResolvedValue(ok({ bounced: [] }));
    const many = Array.from({ length: 1500 }, (_, i) => `p${i}@acme.com`);

    await findBouncedEmails(identity, many);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).emails).toHaveLength(1000);
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body).emails).toHaveLength(500);
  });

  it("fails loud on a non-2xx — never 'nobody bounced'", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" });
    await expect(findBouncedEmails(identity, ["a@acme.com"])).rejects.toBeInstanceOf(BounceSourceError);
  });

  it("fails loud on a body without a bounced array", async () => {
    fetchSpy.mockResolvedValue(ok({}));
    await expect(findBouncedEmails(identity, ["a@acme.com"])).rejects.toBeInstanceOf(BounceSourceError);
  });

  it("fails loud when the service is not configured", async () => {
    delete process.env.INSTANTLY_SERVICE_URL;
    await expect(findBouncedEmails(identity, ["a@acme.com"])).rejects.toBeInstanceOf(BounceConfigError);
  });
});
