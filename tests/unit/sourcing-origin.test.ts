import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  audienceSourcingOriginSlug,
  isCrmSourcedFeature,
  resetSourcingOriginCache,
  serveListKind,
  sourcingOriginSlug,
  withSourcingOrigin,
} from "../../src/services/sourcing-origin.js";
import { fetchSourcingOriginsByList, SourcingOriginError } from "../../src/lib/features-sourcing.js";

// tests/setup.ts mocks the client with the shipped catalogue; the real client
// is exercised through importActual below.
const actual = await vi.importActual<typeof import("../../src/lib/features-sourcing.js")>(
  "../../src/lib/features-sourcing.js"
);

const fetchBefore = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = fetchBefore;
});

beforeEach(() => {
  resetSourcingOriginCache();
});

const apollo = { id: "a1", provider: "apollo", filters: { person_titles: ["CEO"] } };
const signal = { id: "a2", provider: "apollo", filters: { buying_signal: { type: "hiring", window_days: 30 } } };
const engagement = {
  id: "a3",
  provider: "apollo",
  filters: { buying_signal: { type: "linkedin_engagement", window_days: 30 } },
};

describe("serve routing on either label", () => {
  it("the CRM outreach channel and the CRM origin both mean 'serve from the CRM'", () => {
    expect(isCrmSourcedFeature("sales-crm-email-outreach")).toBe(true);
    expect(isCrmSourcedFeature("sourcing-crm-contacts")).toBe(true);
    expect(isCrmSourcedFeature("sales-cold-email-outreach")).toBe(false);
    expect(isCrmSourcedFeature("sourcing-apollo-cold-filters")).toBe(false);
    expect(isCrmSourcedFeature(undefined)).toBe(false);
  });

  it("serveListKind follows serve-next: CRM label wins, else the audience's own list", () => {
    expect(serveListKind(apollo, "sales-crm-email-outreach")).toBe("crm_contacts");
    expect(serveListKind(apollo, "sourcing-crm-contacts")).toBe("crm_contacts");
    expect(serveListKind(apollo, "sales-cold-email-outreach")).toBe("apollo_search");
    expect(serveListKind(signal, undefined)).toBe("apollo_buying_signal");
    expect(serveListKind({ id: "c", provider: "crm", filters: null }, "sales-cold-email-outreach")).toBe("crm_contacts");
    expect(serveListKind({ id: "n", provider: null, filters: null }, undefined)).toBeNull();
  });
});

describe("origin slug of a list (features-service catalogue)", () => {
  it("maps every list kind through the catalogue", async () => {
    expect(await audienceSourcingOriginSlug(apollo)).toBe("sourcing-apollo-cold-filters");
    expect(await audienceSourcingOriginSlug(signal)).toBe("sourcing-apollo-buying-signals");
    expect(await audienceSourcingOriginSlug(engagement)).toBe("sourcing-linkedin-engagement-signals");
    expect(await sourcingOriginSlug("crm_contacts")).toBe("sourcing-crm-contacts");
    expect(await sourcingOriginSlug("linkedin_engagement")).toBe("sourcing-linkedin-engagement-signals");
  });

  it("an audience with no provider has no origin: throws with the audience in context", async () => {
    await expect(audienceSourcingOriginSlug({ id: "nope", provider: null, filters: null })).rejects.toThrow(/nope/);
  });

  it("a list the catalogue does not name throws, never a fallback", async () => {
    vi.mocked(fetchSourcingOriginsByList).mockResolvedValueOnce(new Map([["apollo_search", "sourcing-apollo-cold-filters"]]));
    await expect(sourcingOriginSlug("crm_contacts")).rejects.toBeInstanceOf(SourcingOriginError);
  });

  it("a failed read is not cached: the next call reads again", async () => {
    vi.mocked(fetchSourcingOriginsByList).mockRejectedValueOnce(new SourcingOriginError("down"));
    await expect(sourcingOriginSlug("apollo_search")).rejects.toThrow("down");
    expect(await sourcingOriginSlug("apollo_search")).toBe("sourcing-apollo-cold-filters");
  });

  it("withSourcingOrigin labels the tracking block, keeping the rest", () => {
    const id = withSourcingOrigin(
      { orgId: "o", workflowTracking: { brandIds: ["b"], featureSlug: "sales-cold-email-outreach" } },
      "sourcing-apollo-cold-filters"
    );
    expect(id.workflowTracking).toEqual({ brandIds: ["b"], featureSlug: "sourcing-apollo-cold-filters" });
  });
});

describe("features-service client", () => {
  it("reads /public/sourcing-origins and maps list kinds to slugs", async () => {
    process.env.FEATURES_SERVICE_URL = "http://features:8080";
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          origins: [
            { slug: "sourcing-apollo-cold-filters", audienceLists: ["apollo_search"] },
            { slug: "sourcing-crm-contacts", audienceLists: ["crm_contacts"] },
          ],
          sourcingChannels: [],
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    const map = await actual.fetchSourcingOriginsByList();
    expect(calls).toEqual(["http://features:8080/public/sourcing-origins"]);
    expect(map.get("apollo_search")).toBe("sourcing-apollo-cold-filters");
    expect(map.get("crm_contacts")).toBe("sourcing-crm-contacts");
  });

  it("fails loud on a non-2xx, a malformed body, or a missing env", async () => {
    process.env.FEATURES_SERVICE_URL = "http://features:8080";
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    await expect(actual.fetchSourcingOriginsByList()).rejects.toThrow(/503/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ origins: "x" }), { status: 200 })) as typeof fetch;
    await expect(actual.fetchSourcingOriginsByList()).rejects.toThrow(/malformed/);
    delete process.env.FEATURES_SERVICE_URL;
    await expect(actual.fetchSourcingOriginsByList()).rejects.toThrow(/FEATURES_SERVICE_URL/);
  });
});
