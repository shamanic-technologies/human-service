process.env.HUMAN_SERVICE_DATABASE_URL =
  process.env.HUMAN_SERVICE_DATABASE_URL || "postgresql://test:test@localhost:5432/human_test";
process.env.HUMAN_SERVICE_API_KEY = "test-api-key";
process.env.NODE_ENV = "test";
process.env.RUNS_SERVICE_URL = "";
process.env.RUNS_SERVICE_API_KEY = "";
process.env.KEY_SERVICE_URL = "";
process.env.KEY_SERVICE_API_KEY = "";
process.env.SCRAPING_SERVICE_URL = "";
process.env.SCRAPING_SERVICE_API_KEY = "";

// Own-company gate (src/services/own-company.ts) reads the brand from
// brand-service on every branded serve and preview. Default answer: a brand with
// no domain and no usable name, so the gate is a no-op and every other suite
// stays about what it is about. tests/**/own-company*.test.ts mock it themselves.
import { vi } from "vitest";
vi.mock("../src/lib/brand-identity.js", () => ({
  getBrandIdentity: async (brandId: string) => ({
    id: brandId,
    domain: null,
    url: null,
    name: "",
    salesRepEmail: null,
  }),
}));

// Sourcing origins (src/lib/features-sourcing.ts) are read from features-service
// by every list build (pointer build, refill, portfolio, competitor engagement,
// preview companies). Default answer: the features-service catalogue as shipped
// 2026-10-07. tests/**/sourcing-origin*.test.ts drive it themselves.
vi.mock("../src/lib/features-sourcing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/features-sourcing.js")>();
  return {
    ...actual,
    fetchSourcingOriginsByList: vi.fn(async () =>
      new Map([
        ["apollo_search", "sourcing-apollo-cold-filters"],
        ["apollo_buying_signal", "sourcing-apollo-buying-signals"],
        ["linkedin_engagement", "sourcing-linkedin-engagement-signals"],
        ["crm_contacts", "sourcing-crm-contacts"],
        ["apify_search", "sourcing-apify-search"],
      ])
    ),
  };
});
