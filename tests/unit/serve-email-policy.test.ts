import { describe, it, expect } from "vitest";
import { shapeEmailVerdict } from "../../src/lib/serve-email-policy.js";
import { ACCEPTED_EMAILS, isVerdictAccepted, widenedVerdicts } from "../../src/lib/email-verification.js";

describe("isVerdictAccepted", () => {
  it("valid always; catch_all only when asked; never unknown / invalid / risky", () => {
    const v = (verdict: "valid" | "catch_all" | "unknown" | "invalid" | "risky") => ({
      verdict,
      deliverable: verdict === "valid",
    });
    for (const a of [undefined, "valid_only", "valid_and_catch_all"] as const) {
      expect(isVerdictAccepted(v("valid"), a)).toBe(true);
      for (const bad of ["unknown", "invalid", "risky"] as const) expect(isVerdictAccepted(v(bad), a)).toBe(false);
    }
    expect(isVerdictAccepted(v("catch_all"), undefined)).toBe(false);
    expect(isVerdictAccepted(v("catch_all"), "valid_only")).toBe(false);
    expect(isVerdictAccepted(v("catch_all"), "valid_and_catch_all")).toBe(true);
  });

  it("valid_catch_all_and_unknown is deprecated: behaves as valid_and_catch_all, never unknown (CATCHALL-BOUNCE-1016)", () => {
    const v = (verdict: "valid" | "catch_all" | "unknown" | "invalid" | "risky") => ({
      verdict,
      deliverable: verdict === "valid",
    });
    for (const verdict of ["valid", "catch_all", "unknown", "invalid", "risky"] as const) {
      expect(isVerdictAccepted(v(verdict), "valid_catch_all_and_unknown")).toBe(
        isVerdictAccepted(v(verdict), "valid_and_catch_all")
      );
    }
    for (const ok of ["valid", "catch_all"] as const) expect(isVerdictAccepted(v(ok), "valid_catch_all_and_unknown")).toBe(true);
    for (const bad of ["unknown", "invalid", "risky"] as const) expect(isVerdictAccepted(v(bad), "valid_catch_all_and_unknown")).toBe(false);
  });

  it("no option ever widens to unknown (CATCHALL-BOUNCE-1016)", () => {
    for (const accepted of [undefined, ...ACCEPTED_EMAILS]) {
      expect(widenedVerdicts(accepted)).not.toContain("unknown");
      expect(isVerdictAccepted({ verdict: "unknown", deliverable: false }, accepted)).toBe(false);
    }
    expect(widenedVerdicts("valid_catch_all_and_unknown")).toEqual(widenedVerdicts("valid_and_catch_all"));
  });
});

describe("shapeEmailVerdict", () => {
  it("never puts the field on the wire for a caller that stated nothing", () => {
    expect(shapeEmailVerdict({ status: "served", person: 1, emailVerdict: "valid" as const }, undefined)).toEqual({
      status: "served",
      person: 1,
    });
    expect(Object.keys(shapeEmailVerdict({ status: "served", emailVerdict: undefined }, undefined))).toEqual(["status"]);
  });

  it("states it on every served answer when asked (null = no verification), never elsewhere", () => {
    expect(shapeEmailVerdict({ status: "served", emailVerdict: "catch_all" as const }, "valid_and_catch_all")).toEqual({
      status: "served",
      emailVerdict: "catch_all",
    });
    expect(shapeEmailVerdict({ status: "served" }, "valid_only")).toEqual({ status: "served", emailVerdict: null });
    expect(shapeEmailVerdict({ status: "exhausted", emailVerdict: null }, "valid_only")).toEqual({ status: "exhausted" });
  });
});
