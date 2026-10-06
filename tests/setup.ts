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
