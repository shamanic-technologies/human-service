import { describe, it, expect } from "vitest";
import { readExtractRow, publishedEmails, contactPageLinks } from "../../src/services/google-maps-site-contact.js";

// GMAPS-SITE-READ-EMPTY-1126: treg.web.extract returns each provider's OWN row.
describe("readExtractRow", () => {
  it("tinyfish: text + links", () => {
    const r = readExtractRow({ final_url: "https://a.ch/", text: "Hallo info@a.ch", links: ["https://a.ch/kontakt"] });
    expect(r).toEqual({ text: "Hallo info@a.ch", links: ["https://a.ch/kontakt"], finalUrl: "https://a.ch/" });
  });

  it("crawl4ai: markdown, links taken from the markdown", () => {
    const r = readExtractRow({ final_url: "https://a.ch/", markdown: "[Impressum](/impressum) [Mail](mailto:info@a.ch) see https://a.ch/kontakt." });
    expect(r.text).toContain("Impressum");
    expect(r.links).toEqual(["/impressum", "mailto:info@a.ch", "https://a.ch/kontakt"]);
    expect(contactPageLinks("https://a.ch/", r.links)).toEqual(["https://a.ch/impressum", "https://a.ch/kontakt"]);
    expect(publishedEmails([r])).toEqual(["info@a.ch"]);
  });

  it("search1api: content + link", () => {
    const r = readExtractRow({ title: "Shop", link: "http://www.a.ch/", content: "Tel. 044 | info(at)a.ch" });
    expect(r.finalUrl).toBe("http://www.a.ch/");
    expect(publishedEmails([r])).toEqual(["info@a.ch"]);
  });

  it("parallel: full_content null, excerpts joined", () => {
    const r = readExtractRow({ url: "http://a.ch/", excerpts: ["one", "kontakt@a.ch"], full_content: null });
    expect(r.text).toBe("one\n\nkontakt@a.ch");
  });

  it("a row with no words reads text null, never invented", () => {
    expect(readExtractRow({ final_url: "https://a.ch/", ok: true, text_len: 0 })).toEqual({ text: null, links: [], finalUrl: "https://a.ch/" });
  });

  it("a link with a malformed % sequence is skipped, never a crash (GMAPS-SET-ASIDE-1127)", () => {
    const links = ["https://a.ch/kontakt%E0%A4%A", "mailto:info%ZZ@a.ch", "https://a.ch/impressum", "mailto:hallo@a.ch"];
    expect(contactPageLinks("https://a.ch/", links)).toEqual(["https://a.ch/impressum"]);
    expect(publishedEmails([{ text: null, links }])).toEqual(["hallo@a.ch"]);
  });
});
