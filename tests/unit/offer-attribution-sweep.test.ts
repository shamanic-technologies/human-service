import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Both collaborators are mocked: this file pins the CADENCE (when the sweep
// runs, when it refuses to) — the attribution rule itself is pinned by
// tests/integration/backfill-audience-offers.test.ts and the sweep's own
// integration test.
const loadOfferlessPairs = vi.fn();
const backfillAudienceOffers = vi.fn();
const getMigrationState = vi.fn(() => "ready");

vi.mock("../../src/services/audience-offer-backfill.js", () => ({
  loadOfferlessPairs: (...args: unknown[]) => loadOfferlessPairs(...args),
  backfillAudienceOffers: (...args: unknown[]) => backfillAudienceOffers(...args),
}));

vi.mock("../../src/lib/migration-state.js", () => ({
  getMigrationState: () => getMigrationState(),
}));

const { runOfferAttributionSweep, startOfferAttributionSweep } = await import(
  "../../src/services/offer-attribution-sweep.js"
);

const PAIR = {
  orgId: "a0000000-0000-4000-8000-0000000000a1",
  brandId: "b0000000-0000-4000-8000-00000000000a",
  audienceIds: ["c0000000-0000-4000-8000-000000000001"],
};

function result(over: Record<string, unknown> = {}) {
  return {
    dryRun: false,
    scanned: 1,
    pairs: 1,
    attributed: 1,
    wouldAttribute: 1,
    unattributed: 0,
    skipped: [],
    assignments: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getMigrationState.mockReturnValue("ready");
  loadOfferlessPairs.mockResolvedValue({ scanned: 1, pairs: [PAIR] });
  backfillAudienceOffers.mockResolvedValue(result());
  delete process.env.OFFER_ATTRIBUTION_SWEEP_INTERVAL_MS;
  delete process.env.OFFER_ATTRIBUTION_SWEEP_INITIAL_DELAY_MS;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("offer attribution sweep — one run", () => {
  it("attributes offer-less audiences with nobody triggering anything", async () => {
    const res = await runOfferAttributionSweep();

    expect(backfillAudienceOffers).toHaveBeenCalledWith([PAIR], 1, { dryRun: false });
    expect(res?.attributed).toBe(1);
  });

  it("issues NO brand-service read when every audience already carries an offer", async () => {
    loadOfferlessPairs.mockResolvedValue({ scanned: 0, pairs: [] });

    const res = await runOfferAttributionSweep();

    expect(backfillAudienceOffers).not.toHaveBeenCalled();
    expect(res?.attributed).toBe(0);
  });

  it("skips while the schema is not migrated — never reads the DB behind the 503 gate", async () => {
    getMigrationState.mockReturnValue("pending");

    expect(await runOfferAttributionSweep()).toBeNull();
    expect(loadOfferlessPairs).not.toHaveBeenCalled();
  });

  it("survives a missing brand-service config instead of taking the process down", async () => {
    const { BrandConfigError } = await import("../../src/lib/brand-offers.js");
    backfillAudienceOffers.mockRejectedValue(new BrandConfigError("not configured"));

    expect(await runOfferAttributionSweep()).toBeNull();
    expect(console.error).toHaveBeenCalled();
    // The next tick still works — the failure is per-tick, never sticky.
    backfillAudienceOffers.mockResolvedValue(result());
    expect((await runOfferAttributionSweep())?.attributed).toBe(1);
  });

  it("survives any other failure and keeps the next tick alive", async () => {
    backfillAudienceOffers.mockRejectedValue(new Error("boom"));
    expect(await runOfferAttributionSweep()).toBeNull();

    backfillAudienceOffers.mockResolvedValue(result());
    expect((await runOfferAttributionSweep())?.attributed).toBe(1);
  });

  it("never overlaps itself", async () => {
    let release: () => void = () => {};
    backfillAudienceOffers.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(result())))
    );

    const first = runOfferAttributionSweep();
    // Let the first tick reach the (pending) backfill call.
    await new Promise((r) => setTimeout(r, 0));
    const second = await runOfferAttributionSweep();

    expect(second).toBeNull();
    expect(backfillAudienceOffers).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

describe("offer attribution sweep — cadence", () => {
  it("does NOTHING on the boot path: arming only schedules, the first tick is delayed", () => {
    vi.useFakeTimers();
    process.env.OFFER_ATTRIBUTION_SWEEP_INITIAL_DELAY_MS = "60000";
    process.env.OFFER_ATTRIBUTION_SWEEP_INTERVAL_MS = "900000";

    const stop = startOfferAttributionSweep();

    expect(loadOfferlessPairs).not.toHaveBeenCalled();
    stop();
  });

  it("runs on its own after the delay, then on every interval", async () => {
    vi.useFakeTimers();
    process.env.OFFER_ATTRIBUTION_SWEEP_INITIAL_DELAY_MS = "1000";
    process.env.OFFER_ATTRIBUTION_SWEEP_INTERVAL_MS = "5000";

    const stop = startOfferAttributionSweep();

    await vi.advanceTimersByTimeAsync(1000);
    expect(loadOfferlessPairs).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(loadOfferlessPairs).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(loadOfferlessPairs).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(20000);
    expect(loadOfferlessPairs).toHaveBeenCalledTimes(3);
  });

  it("interval 0 is a kill switch", async () => {
    vi.useFakeTimers();
    process.env.OFFER_ATTRIBUTION_SWEEP_INTERVAL_MS = "0";

    const stop = startOfferAttributionSweep();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(loadOfferlessPairs).not.toHaveBeenCalled();
    stop();
  });

  it("falls back to the default cadence on an unusable env value", async () => {
    vi.useFakeTimers();
    process.env.OFFER_ATTRIBUTION_SWEEP_INITIAL_DELAY_MS = "not-a-number";
    process.env.OFFER_ATTRIBUTION_SWEEP_INTERVAL_MS = "-5";

    const stop = startOfferAttributionSweep();
    // Default initial delay is 60s.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(loadOfferlessPairs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(loadOfferlessPairs).toHaveBeenCalledTimes(1);

    stop();
  });
});
