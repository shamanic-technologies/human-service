import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PROVIDER_TIMEOUT_MS,
  isTransientConnectError,
  fetchWithConnectRetry,
} from "../../src/services/people-providers";

// The bound on a single provider call. It exists so a stalled apollo-service
// build cannot hang /suggest until undici's implicit ~300s headers timeout —
// and its value must be large enough that a HEALTHY build wins the race.
describe("PROVIDER_TIMEOUT_MS", () => {
  it("outlasts apollo-service's own 210s self-bound, with margin for the network", () => {
    // A measured healthy build took 149s; apollo-service now promises to answer
    // within 210s. Anything at or below that aborts a build that HAD finished.
    expect(PROVIDER_TIMEOUT_MS).toBeGreaterThanOrEqual(240_000);
  });

  it("still bounds the call below undici's implicit ~300s headers timeout", () => {
    // The bound must remain OUR bound: past ~300s undici aborts first and the
    // provider call is effectively unbounded from our side.
    expect(PROVIDER_TIMEOUT_MS).toBeLessThan(300_000);
  });
});

describe("provider call abort classification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats a client-side timeout abort as NON-transient", () => {
    const abort = new Error("The operation was aborted due to timeout");
    abort.name = "TimeoutError";
    expect(isTransientConnectError(abort)).toBe(false);

    const aborted = new Error("This operation was aborted");
    aborted.name = "AbortError";
    expect(isTransientConnectError(aborted)).toBe(false);
  });

  it("still treats a genuine connect-phase failure as transient", () => {
    const err = new Error("fetch failed");
    (err as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(isTransientConnectError(err)).toBe(true);
  });

  it("does NOT retry an aborted request — one attempt, then throws", async () => {
    const abort = new Error("The operation was aborted due to timeout");
    abort.name = "TimeoutError";
    const spy = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal("fetch", spy);

    await expect(fetchWithConnectRetry("http://x/y", { method: "POST" })).rejects.toBe(abort);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retries a transient connect failure", async () => {
    const err = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
    const spy = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    const res = await fetchWithConnectRetry("http://x/y", { method: "POST" });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
