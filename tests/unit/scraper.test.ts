import { describe, it, expect } from "vitest";
import { rankPages, extractLinks } from "../../src/services/scraper.js";

describe("rankPages", () => {
  it("ranks about pages highest", () => {
    const urls = [
      "https://example.com/blog/post-1",
      "https://example.com/about",
      "https://example.com/contact",
      "https://example.com/bio",
    ];

    const ranked = rankPages(urls, 2);
    expect(ranked[0]).toContain("/about");
    expect(ranked[1]).toContain("/bio");
  });

  it("returns at most max pages", () => {
    const urls = [
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ];

    const ranked = rankPages(urls, 2);
    expect(ranked).toHaveLength(2);
  });
});

describe("extractLinks", () => {
  it("extracts same-host links", () => {
    const html = `
      <a href="/about">About</a>
      <a href="https://example.com/blog">Blog</a>
      <a href="https://other.com/page">Other</a>
    `;

    const links = extractLinks(html, "https://example.com");
    expect(links).toContain("https://example.com/about");
    expect(links).toContain("https://example.com/blog");
    expect(links).not.toContain("https://other.com/page");
  });

  it("filters out static assets", () => {
    const html = `
      <a href="/page">Page</a>
      <a href="/image.jpg">Image</a>
      <a href="/style.css">Style</a>
    `;

    const links = extractLinks(html, "https://example.com");
    expect(links).toContain("https://example.com/page");
    expect(links).not.toContain("https://example.com/image.jpg");
    expect(links).not.toContain("https://example.com/style.css");
  });
});
