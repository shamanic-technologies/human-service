import { describe, it, expect } from "vitest";
import {
  buildRefillRequest,
  buildWidenedTarget,
  dedupeSegmentNames,
  isPoolLow,
  pickOffer,
  RUNWAY_DAYS,
} from "../../src/services/audience-refill.js";
import { canBeCharged, type PaymentOutlook } from "../../src/lib/billing-outlook.js";

describe("isPoolLow (people left vs the brand's own daily pace)", () => {
  it("is low when fewer people are left than RUNWAY_DAYS of pace", () => {
    expect(isPoolLow({ remaining: 0, dailyPace: 23 })).toBe(true);
    expect(isPoolLow({ remaining: 86, dailyPace: 40 })).toBe(true);
    expect(isPoolLow({ remaining: 40 * RUNWAY_DAYS - 1, dailyPace: 40 })).toBe(true);
  });

  it("is not low when the pool covers the runway", () => {
    expect(isPoolLow({ remaining: 40 * RUNWAY_DAYS, dailyPace: 40 })).toBe(false);
    expect(isPoolLow({ remaining: 3874, dailyPace: 30 })).toBe(false);
  });

  it("is never low for a brand with no pace (nothing is running out)", () => {
    expect(isPoolLow({ remaining: 0, dailyPace: 0 })).toBe(false);
    expect(isPoolLow({ remaining: 0, dailyPace: Number.NaN })).toBe(false);
  });

  it("honours an explicit runway", () => {
    expect(isPoolLow({ remaining: 50, dailyPace: 10, runwayDays: 3 })).toBe(false);
    expect(isPoolLow({ remaining: 50, dailyPace: 10, runwayDays: 6 })).toBe(true);
  });
});

describe("canBeCharged (billing gate)", () => {
  const outlook = (state: PaymentOutlook["state"]): PaymentOutlook => ({ orgId: "o", state });

  it("only will_charge and charge_due_now can pay", () => {
    expect(canBeCharged(outlook("will_charge"))).toBe(true);
    expect(canBeCharged(outlook("charge_due_now"))).toBe(true);
  });

  it("every other state, and no billing account, cannot", () => {
    for (const s of ["charge_blocked", "no_autopay", "idle", "unknown"] as const) {
      expect(canBeCharged(outlook(s))).toBe(false);
    }
    expect(canBeCharged(null)).toBe(false);
  });
});

describe("refill helpers", () => {
  it("dedupes a name already taken in the scope, case-insensitively", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    expect(dedupeSegmentNames(["Site Engineers", "Architects"], ["site engineers"], now)).toEqual([
      "Site Engineers Oct 2",
      "Architects",
    ]);
    expect(
      dedupeSegmentNames(["A"], ["a", "A Oct 2"], now)
    ).toEqual(["A Oct 2 2"]);
  });

  it("picks the offer most active audiences belong to, ties to the most recent", () => {
    const row = (offerId: string | null, day: number) =>
      ({ offerId, createdAt: new Date(2026, 8, day) }) as never;
    expect(pickOffer([row("x", 1), row("y", 2), row("x", 3)])).toBe("x");
    expect(pickOffer([row("x", 1), row("y", 2)])).toBe("y");
    expect(pickOffer([row(null, 1)])).toBeNull();
  });

  it("asks the split for the next closest buyers, outside every audience already contacted", () => {
    const text = buildRefillRequest({
      target: "Construction managers in Paraguay.",
      offer: { name: "ObraCam", description: "Cameras for construction sites." },
      existing: [
        { name: "Up to 50 Employees PY", description: "Small builders in Paraguay." },
        { name: "Project Directors", description: null },
      ],
    });
    expect(text).toContain("WHAT THIS COMPANY SELLS: ObraCam: Cameras for construction sites.");
    expect(text).toContain("ITS TARGET SO FAR: Construction managers in Paraguay.");
    expect(text).toContain("NEXT closest");
    expect(text).toContain("Return at least one segment.");
    expect(text).toContain("- Up to 50 Employees PY: Small builders in Paraguay.");
    expect(text).toContain("- Project Directors");
    expect(buildRefillRequest({ target: "t", offer: null, existing: [] })).toContain(
      "WHAT THIS COMPANY SELLS: (not stated)"
    );
  });

  it("screens the widened audiences against the old target plus every new segment", () => {
    expect(buildWidenedTarget("Old.", [{ description: "A." }, { description: "B." }])).toBe(
      "Old.\nAlso:\n- A.\n- B."
    );
  });
});
