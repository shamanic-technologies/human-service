import { describe, it, expect } from "vitest";
import { MAX_COMPETITOR_PAGES, pickCompetitorPages } from "../../src/services/competitor-engagement-audience.js";

const c = (name: string, linkedinUrl: string | null) => ({ name, domain: `${name}.com`, linkedinUrl });

describe("pickCompetitorPages", () => {
  it("keeps brand-service's order, skips competitors with no page, caps at 3", () => {
    expect(MAX_COMPETITOR_PAGES).toBe(3);
    const pages = pickCompetitorPages([
      c("a", "https://www.linkedin.com/company/a/"),
      c("b", null),
      c("c", "https://www.linkedin.com/company/c/"),
      c("d", "https://www.linkedin.com/company/d/"),
      c("e", "https://www.linkedin.com/company/e/"),
    ]);
    expect(pages).toEqual([
      "https://www.linkedin.com/company/a/",
      "https://www.linkedin.com/company/c/",
      "https://www.linkedin.com/company/d/",
    ]);
  });

  it("drops a page two competitors share (case and trailing slash ignored)", () => {
    expect(
      pickCompetitorPages([
        c("a", "https://www.linkedin.com/company/acme/"),
        c("b", "https://www.linkedin.com/company/ACME"),
      ])
    ).toEqual(["https://www.linkedin.com/company/acme/"]);
  });

  it("answers no page when none links one (never invents one)", () => {
    expect(pickCompetitorPages([c("a", null), c("b", "  ")])).toEqual([]);
    expect(pickCompetitorPages([])).toEqual([]);
  });
});
