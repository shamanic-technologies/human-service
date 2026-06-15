import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  normalizeLinkedinUrl,
} from "../../src/services/suppression.js";

describe("normalizeEmail", () => {
  it("trims + lowercases", () => {
    expect(normalizeEmail("  Jane@Acme.IO ")).toBe("jane@acme.io");
  });
  it("null / empty → null", () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
  });
});

describe("normalizeLinkedinUrl", () => {
  it("strips protocol, www, trailing slash, query, fragment + lowercases", () => {
    expect(
      normalizeLinkedinUrl("https://www.LinkedIn.com/in/Sara/?utm=x#top")
    ).toBe("linkedin.com/in/sara");
  });
  it("http + no www + no trailing slash already canonical", () => {
    expect(normalizeLinkedinUrl("http://linkedin.com/in/sara")).toBe(
      "linkedin.com/in/sara"
    );
  });
  it("two different URL spellings of the same profile normalize equal", () => {
    const a = normalizeLinkedinUrl("https://www.linkedin.com/in/sara/");
    const b = normalizeLinkedinUrl("http://linkedin.com/in/sara");
    expect(a).toBe(b);
  });
  it("null / empty → null", () => {
    expect(normalizeLinkedinUrl(null)).toBeNull();
    expect(normalizeLinkedinUrl("")).toBeNull();
  });
});
