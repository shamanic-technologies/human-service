import { describe, it, expect } from "vitest";
import {
  readEmailVerification,
  EmailVerificationError,
} from "../../src/lib/email-verification.js";

describe("readEmailVerification — the provider's verdict on a revealed email", () => {
  it("no email ⟹ nothing to verify", () => {
    expect(readEmailVerification("apollo", undefined, null)).toBeNull();
    expect(readEmailVerification("apollo", undefined, "  ")).toBeNull();
  });

  it.each([
    [{ verdict: "valid", deliverable: true }],
    [{ verdict: "catch_all", deliverable: false }],
    [{ verdict: "invalid", deliverable: false }],
  ])("reads %j", (raw) => {
    expect(readEmailVerification("apollo", { ...raw, verifier: "bounceverify" }, "a@b.com")).toEqual(raw);
  });

  it.each([
    [undefined],
    [null],
    [{ verdict: "valid" }],
    [{ deliverable: true }],
    [{ verdict: "maybe", deliverable: true }],
  ])("an email with no usable verdict %j fails loud — never served unverified", (raw) => {
    expect(() => readEmailVerification("apollo", raw, "a@b.com")).toThrow(EmailVerificationError);
  });
});
