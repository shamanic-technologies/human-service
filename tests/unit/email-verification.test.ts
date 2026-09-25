import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  mapVerdict,
  verifyEmail,
  isServableVerdict,
  EmailVerificationError,
  VERIFY_EMAIL_COST,
} from "../../src/lib/email-verification.js";

const fetchBefore = globalThis.fetch;
afterAll(() => {
  vi.stubGlobal("fetch", fetchBefore);
});

const ENV = {
  RUNS_SERVICE_URL: "http://runs:8080",
  RUNS_SERVICE_API_KEY: "runs-key",
  BILLING_SERVICE_URL: "http://billing:8080",
  BILLING_SERVICE_API_KEY: "billing-key",
  KEY_SERVICE_URL: "http://key:8080",
  KEY_SERVICE_API_KEY: "key-key",
};
const envBefore = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const [k, v] of Object.entries(envBefore)) process.env[k] = v;
});

const identity = { orgId: "org-1", userId: "user-1", runId: "parent-run" };

type Call = { url: string; method: string; body: any; headers: Record<string, string> };

function json(status: number, body: unknown) {
  return { ok: status < 300, status, text: async () => JSON.stringify(body) };
}

// A fake fleet: runs-service, billing-service, key-service, Apify. Each test
// can override one answer; every call is recorded in order.
function fleet(overrides: {
  authorize?: unknown;
  apifyStatus?: number;
  apifyRows?: unknown;
} = {}) {
  const calls: Call[] = [];
  let costSeq = 0;
  const spy = vi.fn(async (url: string, init: any = {}) => {
    const call: Call = {
      url: String(url),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
    };
    calls.push(call);
    const u = call.url;
    if (u === "http://runs:8080/v1/runs") return json(201, { id: "child-run" });
    if (u.endsWith("/costs") && call.method === "POST")
      return json(201, { costs: call.body.items.map(() => ({ id: `cost-${++costSeq}` })) });
    if (u.includes("/costs/")) return json(200, { id: "x" });
    if (u === "http://runs:8080/v1/runs/child-run") return json(200, { id: "child-run" });
    if (u.includes("/customer_balance/authorize"))
      return json(200, overrides.authorize ?? { sufficient: true });
    if (u.includes("/keys/platform/apify/decrypt")) return json(200, { key: "apify-token" });
    if (u.includes("api.apify.com"))
      return json(
        overrides.apifyStatus ?? 201,
        overrides.apifyRows ?? [{ email: "jane@acme.com", status: "valid", is_catch_all: false }]
      );
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", spy);
  return calls;
}

const label = (c: Call) => {
  if (c.url.includes("api.apify.com")) return "apify";
  if (c.url.includes("/authorize")) return "authorize";
  if (c.url.includes("/decrypt")) return "key";
  if (c.url.endsWith("/v1/runs")) return "create-run";
  if (c.url.endsWith("/costs")) return `cost:${c.body.items[0].status}`;
  if (c.url.includes("/costs/")) return `cost-patch:${c.body.status}`;
  return `run:${c.body.status}`;
};

describe("mapVerdict", () => {
  it.each([
    [{ status: "invalid", is_catch_all: true }, "invalid"],
    [{ status: "risky", is_catch_all: true }, "catch_all"],
    [{ status: "valid", is_spamtrap: true }, "risky"],
    [{ status: "valid" }, "valid"],
    [{ status: "risky" }, "risky"],
    [{ status: "unknown" }, "unknown"],
    [{ status: "something-new" }, "unknown"],
    [undefined, "unknown"],
  ])("%j → %s", (row, verdict) => {
    expect(mapVerdict(row as Record<string, unknown> | undefined)).toBe(verdict);
  });
});

describe("serving policy", () => {
  it("serves valid only — never catch_all / invalid / unknown / risky", () => {
    expect(isServableVerdict("valid")).toBe(true);
    expect(isServableVerdict("catch_all")).toBe(false);
    expect(isServableVerdict("invalid")).toBe(false);
    expect(isServableVerdict("unknown")).toBe(false);
    expect(isServableVerdict("risky")).toBe(false);
  });
});

describe("verifyEmail — the cost protocol", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("provisions, authorizes, executes, actualizes, then releases the hold", async () => {
    const calls = fleet();
    const verdict = await verifyEmail("jane@acme.com", identity);
    expect(verdict).toBe("valid");
    expect(calls.map(label)).toEqual([
      "create-run",
      "cost:provisioned",
      "authorize",
      "key",
      "apify",
      "cost:actual",
      "cost-patch:cancelled",
      "run:completed",
    ]);
    // The run is a child of the caller's run, billed to the caller's org.
    expect(calls[0].headers["x-run-id"]).toBe("parent-run");
    expect(calls[0].headers["x-org-id"]).toBe("org-1");
    expect(calls[1].body.items[0]).toMatchObject({
      costName: VERIFY_EMAIL_COST,
      costSource: "platform",
      quantity: 1,
    });
    expect(calls[4].headers.Authorization).toBe("Bearer apify-token");
    expect(calls[4].body).toEqual({ emails: ["jane@acme.com"] });
  });

  it("an `unknown` result is not billed (the actor charges decisive results only)", async () => {
    const calls = fleet({ apifyRows: [{ email: "jane@acme.com", status: "unknown" }] });
    expect(await verifyEmail("jane@acme.com", identity)).toBe("unknown");
    expect(calls.map(label)).not.toContain("cost:actual");
    expect(calls.map(label)).toContain("cost-patch:cancelled");
  });

  it("a missing row for the address reads as unknown", async () => {
    fleet({ apifyRows: [{ email: "someone-else@acme.com", status: "valid" }] });
    expect(await verifyEmail("Jane@Acme.com", identity)).toBe("unknown");
  });

  it("insufficient balance: never calls Apify, releases the hold, fails the run", async () => {
    const calls = fleet({ authorize: { sufficient: false, balance_cents: "0", required_cents: "1" } });
    await expect(verifyEmail("jane@acme.com", identity)).rejects.toBeInstanceOf(
      EmailVerificationError
    );
    const seq = calls.map(label);
    expect(seq).not.toContain("apify");
    expect(seq).toContain("cost-patch:cancelled");
    expect(seq[seq.length - 1]).toBe("run:failed");
  });

  it("an Apify failure fails loud and releases the hold", async () => {
    const calls = fleet({ apifyStatus: 500, apifyRows: { error: "boom" } });
    await expect(verifyEmail("jane@acme.com", identity)).rejects.toThrow(/apify bounceverify responded 500/);
    const seq = calls.map(label);
    expect(seq).not.toContain("cost:actual");
    expect(seq).toContain("cost-patch:cancelled");
    expect(seq[seq.length - 1]).toBe("run:failed");
  });

  it("refuses without a user to bill, before any call", async () => {
    const calls = fleet();
    await expect(verifyEmail("jane@acme.com", { orgId: "org-1" })).rejects.toThrow(/x-user-id/);
    expect(calls).toHaveLength(0);
  });

  it("refuses when a dependency is not configured, before any call", async () => {
    const calls = fleet();
    process.env.BILLING_SERVICE_URL = "";
    await expect(verifyEmail("jane@acme.com", identity)).rejects.toThrow(/BILLING_SERVICE_URL/);
    expect(calls).toHaveLength(0);
  });
});
