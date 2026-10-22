import { describe, it, expect } from "vitest";
import { pgErrorCode } from "../../src/lib/pg-error.js";

describe("pgErrorCode", () => {
  it("reads the code on a bare postgres.js error", () => {
    expect(pgErrorCode(Object.assign(new Error("dup"), { code: "23505" }))).toBe("23505");
  });

  it("reads the code through a DrizzleQueryError-style wrapper", () => {
    const driver = Object.assign(new Error("dup"), { code: "23505" });
    const wrapped = new Error("Failed query: insert ...", { cause: driver });
    expect(pgErrorCode(wrapped)).toBe("23505");
  });

  it("returns undefined when no code exists", () => {
    expect(pgErrorCode(new Error("x"))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode("x")).toBeUndefined();
  });
});
