import { describe, it, expect, vi, afterEach } from "vitest";

vi.unmock("../../src/lib/apollo-person-facts.js");
const { readApolloPersonFacts, PersonFactsSourceError } = await import("../../src/lib/apollo-person-facts.js");

const fetchBefore = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchBefore;
});

describe("readApolloPersonFacts", () => {
  it("maps a known person to a teaser snapshot and skips an unknown one", async () => {
    process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
    process.env.APOLLO_SERVICE_API_KEY = "k";
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        people: [
          {
            apolloPersonId: "a1", known: true, revealedAt: "2026-08-01T00:00:00Z", title: "Chiropractor", headline: null,
            seniority: "owner", city: "Denver", state: "Colorado", country: "United States",
            organization: { name: "WellSet", domain: "wellsetdenver.com", industry: "health", employees: 5, city: null, state: null, country: null, keywords: [] },
          },
          { apolloPersonId: "a2", known: false, revealedAt: null, title: null, headline: null, seniority: null, city: null, state: null, country: null, organization: null },
        ],
      }),
      text: async () => "",
    }));
    globalThis.fetch = spy as never;
    const out = await readApolloPersonFacts(["a1", "a2"]);
    expect(spy).toHaveBeenCalledWith("http://apollo:8080/internal/reveal-records/person-facts", expect.objectContaining({ method: "POST" }));
    expect(out.get("a1")).toMatchObject({ title: "Chiropractor", organizationName: "WellSet", organizationEmployees: 5, organizationKeywords: null });
    expect(out.has("a2")).toBe(false);
  });

  it("fails loud on an unreadable body", async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })) as never;
    await expect(readApolloPersonFacts(["a1"])).rejects.toBeInstanceOf(PersonFactsSourceError);
  });
});
