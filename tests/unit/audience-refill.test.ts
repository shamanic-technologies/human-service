import { describe, it, expect } from "vitest";
import {
  buildInTargetRefillRequest,
  buildWideningRequest,
  buildWidenedTarget,
  pickValidatedTarget,
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

  const existing = [
    { name: "Up to 50 Employees PY", description: "Small builders in Paraguay." },
    { name: "Project Directors", description: null },
  ];
  const offer = { name: "ObraCam", description: "Cameras for construction sites." };

  it("first asks for people INSIDE the validated target, zero being a correct answer", () => {
    const text = buildInTargetRefillRequest({ target: "Construction managers in Paraguay.", offer, existing });
    expect(text).toContain("WHAT THIS COMPANY SELLS: ObraCam: Cameras for construction sites.");
    expect(text).toContain("THE TARGET THE CLIENT VALIDATED: Construction managers in Paraguay.");
    expect(text).toContain("Every segment stays inside the target as written");
    expect(text).toContain("return ZERO segments");
    expect(text).not.toContain("NEXT closest");
    expect(text).not.toContain("adjacent");
    expect(text).toContain("- Up to 50 Employees PY: Small builders in Paraguay.");
    expect(text).toContain("- Project Directors");
  });

  it("only for a proposal, asks for the next closest buyers outside every audience", () => {
    const text = buildWideningRequest({ target: "Construction managers in Paraguay.", offer, existing });
    expect(text).toContain("ITS TARGET SO FAR: Construction managers in Paraguay.");
    expect(text).toContain("NEXT closest");
    expect(text).toContain("- Project Directors");
    expect(buildWideningRequest({ target: "t", offer: null, existing: [] })).toContain(
      "WHAT THIS COMPANY SELLS: (not stated)"
    );
  });

  it("reads the validated target: newest client-made row, active first, never a refill row", () => {
    const row = (nlPrompt: string | null, source: string | null, status: string, day: number) => ({
      nlPrompt,
      source,
      status,
      createdAt: new Date(2026, 9, day),
    });
    expect(
      pickValidatedTarget([
        row("Validated.", null, "active", 1),
        row("Widened by the refill.", "auto_refill", "active", 4),
        row("Old archived.", "split_proposal", "archived", 3),
      ])
    ).toBe("Validated.");
    expect(pickValidatedTarget([row("Accepted wider.", "widening_accepted", "active", 5), row("Validated.", null, "active", 1)])).toBe(
      "Accepted wider."
    );
    expect(pickValidatedTarget([row("Paused one.", null, "paused", 2), row(null, null, "active", 3)])).toBe("Paused one.");
    expect(pickValidatedTarget([row("x", "auto_refill", "active", 1), row("y", null, "deprecated", 2)])).toBeNull();
  });

  it("screens the widened audiences against the old target plus every new segment", () => {
    expect(buildWidenedTarget("Old.", [{ description: "A." }, { description: "B." }])).toBe(
      "Old.\nAlso:\n- A.\n- B."
    );
  });
});
