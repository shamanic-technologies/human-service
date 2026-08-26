import { describe, it, expect } from "vitest";
import { deriveBusinessLanguages } from "../../src/services/business-languages.js";

const geo = (city: string | null, state: string | null, country: string | null) => ({
  city,
  state,
  country,
});

describe("deriveBusinessLanguages", () => {
  it("resolves Swiss cantons to different leading languages", () => {
    expect(deriveBusinessLanguages(geo("Lugano", "Ticino", "Switzerland"))[0]).toBe("it");
    expect(deriveBusinessLanguages(geo("Geneva", "Geneva", "Switzerland"))[0]).toBe("fr");
    expect(deriveBusinessLanguages(geo("Zurich", "Zurich", "Switzerland"))[0]).toBe("de");
  });

  it("resolves Belgian regions: Flanders → nl, Wallonia → fr, Brussels mixed", () => {
    expect(deriveBusinessLanguages(geo(null, "Vlaams Gewest", "Belgium"))).toEqual(["nl"]);
    expect(deriveBusinessLanguages(geo(null, "Region wallonne", "Belgium"))).toEqual(["fr"]);
    expect(deriveBusinessLanguages(geo("Brussels", null, "Belgium"))).toEqual(["fr", "nl"]);
  });

  it("resolves Canadian provinces: Quebec → fr first, Ontario → en", () => {
    expect(deriveBusinessLanguages(geo("Montreal", "Quebec", "Canada"))).toEqual(["fr", "en"]);
    expect(deriveBusinessLanguages(geo("Toronto", "Ontario", "Canada"))).toEqual(["en"]);
  });

  it("falls back to the country's own ordering when the region is unmapped", () => {
    expect(deriveBusinessLanguages(geo(null, null, "Switzerland"))).toEqual(["de", "fr", "it"]);
    expect(deriveBusinessLanguages(geo(null, null, "Belgium"))).toEqual(["nl", "fr"]);
    expect(deriveBusinessLanguages(geo(null, null, "Canada"))).toEqual(["en", "fr"]);
  });

  it("returns EMPTY for no signal — never a guessed value", () => {
    expect(deriveBusinessLanguages(geo(null, null, null))).toEqual([]);
    expect(deriveBusinessLanguages(null)).toEqual([]);
    expect(deriveBusinessLanguages(geo("Atlantis", "Somewhere", "Neverland"))).toEqual([]);
  });

  it("distinguishes unknown ([]) from known-English (['en'])", () => {
    expect(deriveBusinessLanguages(geo(null, null, "United States"))).toEqual(["en"]);
    expect(deriveBusinessLanguages(geo(null, null, ""))).toEqual([]);
  });

  it("prefers the person's geography over the organization's", () => {
    expect(
      deriveBusinessLanguages(geo(null, null, "Germany"), geo(null, null, "France")),
    ).toEqual(["de"]);
  });

  it("uses the organization's geography only when the person has none", () => {
    expect(
      deriveBusinessLanguages(geo(null, null, null), geo("Lugano", "Ticino", "Switzerland")),
    ).toEqual(["it", "de"]);
  });

  it("is tolerant of casing, ISO codes and diacritics", () => {
    expect(deriveBusinessLanguages(geo(null, null, "DE"))).toEqual(["de"]);
    expect(deriveBusinessLanguages(geo(null, "Genève", "suisse"))[0]).toBe("fr");
    expect(deriveBusinessLanguages(geo(null, null, "  France  "))).toEqual(["fr"]);
  });
});
