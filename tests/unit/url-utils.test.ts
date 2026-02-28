import { describe, it, expect } from "vitest";
import { extractLinks, rankPages } from "../../src/services/url-utils.js";

describe("extractLinks", () => {
  it("extracts same-domain links from HTML", () => {
    const html = `
      <a href="/about">About</a>
      <a href="/blog/post-1">Blog Post</a>
      <a href="https://other.com/page">External</a>
    `;
    const links = extractLinks(html, "https://example.com");
    expect(links).toContain("https://example.com/about");
    expect(links).toContain("https://example.com/blog/post-1");
    expect(links).not.toContain("https://other.com/page");
  });

  it("filters out asset files", () => {
    const html = `
      <a href="/page">Page</a>
      <a href="/style.css">CSS</a>
      <a href="/image.jpg">Image</a>
      <a href="/script.js">Script</a>
      <a href="/doc.pdf">PDF</a>
    `;
    const links = extractLinks(html, "https://example.com");
    expect(links).toContain("https://example.com/page");
    expect(links).not.toContain("https://example.com/style.css");
    expect(links).not.toContain("https://example.com/image.jpg");
    expect(links).not.toContain("https://example.com/script.js");
    expect(links).not.toContain("https://example.com/doc.pdf");
  });

  it("deduplicates links", () => {
    const html = `
      <a href="/about">About 1</a>
      <a href="/about">About 2</a>
    `;
    const links = extractLinks(html, "https://example.com");
    expect(links).toHaveLength(1);
  });

  it("skips invalid URLs gracefully", () => {
    const html = `
      <a href="javascript:void(0)">Invalid</a>
      <a href="/valid">Valid</a>
    `;
    const links = extractLinks(html, "https://example.com");
    expect(links).toContain("https://example.com/valid");
  });
});

describe("rankPages", () => {
  it("scores /about higher than random pages", () => {
    const urls = [
      "https://example.com/random-page",
      "https://example.com/about",
      "https://example.com/deep/nested/page",
    ];
    const ranked = rankPages(urls, 2);
    expect(ranked[0]).toBe("https://example.com/about");
  });

  it("scores methodology/framework pages highly", () => {
    const urls = [
      "https://example.com/random",
      "https://example.com/methodology",
      "https://example.com/framework",
      "https://example.com/approach",
    ];
    const ranked = rankPages(urls, 3);
    expect(ranked).toContain("https://example.com/methodology");
    expect(ranked).toContain("https://example.com/framework");
    expect(ranked).toContain("https://example.com/approach");
  });

  it("penalizes deeply nested pages", () => {
    const urls = [
      "https://example.com/a/b/c/d/e/f",
      "https://example.com/about",
    ];
    const ranked = rankPages(urls, 2);
    expect(ranked[0]).toBe("https://example.com/about");
  });

  it("limits results to max count", () => {
    const urls = [
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
      "https://example.com/d",
    ];
    const ranked = rankPages(urls, 2);
    expect(ranked).toHaveLength(2);
  });

  it("handles empty input", () => {
    const ranked = rankPages([], 5);
    expect(ranked).toEqual([]);
  });
});
