// AUDIENCE-SOURCE-BY-FIT-1126: a proposed audience is sourced by the provider that measured
// best for its target (each provider's sample judged by the ONE shared fit judgment, the most
// fitting companies per dollar wins), and every company + person a preview shows passed that
// judgment.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";

// The Google Maps search is metered through treg (runs / billing / treg); its own suite covers
// that. Here a search inserts the businesses the test names, charged as a real one is.
const gm = vi.hoisted(() => ({
  places: [] as Array<Record<string, unknown>>,
  searches: 0,
  drafts: 0,
}));
vi.mock("../../src/services/google-maps-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/google-maps-source.js")>();
  const { db } = await import("../../src/db/index.js");
  const { googleMapsPlaces, googleMapsQueries } = await import("../../src/db/schema.js");
  const { and, asc, eq, isNull } = await import("drizzle-orm");
  return {
    ...actual,
    draftGoogleMapsFilters: vi.fn(async () => {
      gm.drafts++;
      return { queries: ["restaurants in Sao Paulo", "restaurants in Rio"], country: "br", language: "pt" };
    }),
    GoogleMapsMeters: class {
      search() {
        return {};
      }
      siteRead() {
        return {};
      }
      async close() {}
    },
    runNextQuery: vi.fn(async (audience: { id: string; orgId: string }) => {
      const [q] = await db
        .select()
        .from(googleMapsQueries)
        .where(and(eq(googleMapsQueries.audienceId, audience.id), isNull(googleMapsQueries.ranAt)))
        .orderBy(asc(googleMapsQueries.position))
        .limit(1);
      if (!q) return false;
      gm.searches++;
      if (gm.places.length > 0) {
        await db.insert(googleMapsPlaces).values(
          gm.places.map((p, rank) => ({
            orgId: audience.orgId,
            audienceId: audience.id,
            placeId: String(p.place_id),
            queryId: q.id,
            rank,
            place: p,
          }))
        ).onConflictDoNothing();
      }
      await db
        .update(googleMapsQueries)
        .set({ ranAt: new Date(), chargedMicro: 150, placesCount: gm.places.length, newPlacesCount: gm.places.length })
        .where(eq(googleMapsQueries.id, q.id));
      gm.places = [];
      return true;
    }),
  };
});

import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audienceFitJudgments, audiencePreviewCompanies, audiences } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { ensureProviderChoice, pickProvider, type ProviderSampleResult } from "../../src/services/audience-provider-choice.js";
import { pendingProviderChoice } from "../../src/lib/provider-choice-marker.js";
import { clearPlatformPriceCache } from "../../src/lib/platform-prices.js";

const app = createTestApp();
const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";
const RUN = "00000000-0000-0000-0000-000000000003";
const BRAND = "00000000-0000-4000-8000-0000000001f1";
const APOLLO_AUD = "apollo-aud-fit";
const RESTAURANTS =
  "Owners and managers of restaurants in Brazil. HR, finance and project functions are out.";

const fetchBefore = globalThis.fetch;
const fetchSpy = vi.fn();

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

// apollo-service's companies list: company i is a restaurant unless `kindOf(i)` says otherwise.
let kindOf: (rank: number) => { industry: string; title: string } = () => ({ industry: "restaurants", title: "Owner" });
const companyCalls: number[] = [];
const judgeCalls: Array<Record<string, unknown>> = [];

function apolloCompany(rank: number) {
  const k = kindOf(rank);
  return {
    rank,
    name: `Company ${rank}`,
    apolloOrganizationId: `org-${rank}`,
    domain: `company${rank}.com.br`,
    websiteUrl: `http://company${rank}.com.br`,
    logoUrl: null,
    linkedinUrl: null,
    shortDescription: null,
    industry: k.industry,
    estimatedNumEmployees: 40,
    city: "Sao Paulo",
    state: null,
    country: "Brazil",
    foundedYear: null,
    keywords: [],
    person: { apolloPersonId: `person-${rank}`, firstName: `First${rank}`, lastNameObfuscated: "L***", title: k.title },
  };
}

// The fake judge: a company is the target's when its industry is the target's (a restaurant
// for the restaurants target, software for the SaaS one); a person is out when their title is a
// function the target names as out (HR). The shared judgment's wire is what is under test.
let targetIndustry = "restaurants";
function judge(state: { candidate: Record<string, unknown> }) {
  const c = state.candidate;
  const industry = String(c.organizationIndustry ?? "");
  const company = industry.includes(targetIndustry) ? "in_target" : "out_of_target";
  const title = c.title as string | null;
  const person = !title && !c.name ? "no_person" : /human resources|hr /i.test(`${title} `) ? "out_of_target" : "in_target";
  return {
    answers: {
      company: { type: "choice", choice: company, confidence: 0.9 },
      person: { type: "choice", choice: person, confidence: 0.9 },
    },
  };
}

function route() {
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = new URL(String(url));
    if (u.pathname === `/audiences/${APOLLO_AUD}/companies`) {
      const offset = Number(u.searchParams.get("offset"));
      const limit = Number(u.searchParams.get("limit"));
      companyCalls.push(offset);
      const end = Math.min(offset + limit, 60);
      const companies = [];
      for (let r = offset + 1; r <= end; r++) companies.push(apolloCompany(r));
      return ok({ apolloAudienceId: APOLLO_AUD, count: 900, offset, limit, companies, hasMore: end < 60, creditsCharged: companies.length });
    }
    if (u.pathname === "/orgs/judgments") {
      const body = JSON.parse(init.body ?? "{}");
      judgeCalls.push(body.state);
      return ok(judge(body.state));
    }
    if (u.pathname.startsWith("/v1/platform-prices/")) {
      const name = u.pathname.split("/").pop();
      if (name === "apollo-credit") return ok({ name, pricePerUnitInUsdCents: "2.7621350000" });
      if (name === "treg-micro-usd") return ok({ name, pricePerUnitInUsdCents: "0.0001000000" });
    }
    throw new Error("unexpected url " + u);
  });
}

async function createAudience(extra: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(audiences)
    .values({
      orgId: ORG,
      brandId: BRAND,
      name: `Fit ${Math.random()}`,
      provider: "apollo",
      apolloAudienceId: APOLLO_AUD,
      filters: { organization_industries: ["restaurants"] },
      nlPrompt: RESTAURANTS,
      targetText: RESTAURANTS,
      targetTextOrigin: "audience_target",
      status: "active",
      source: "split_proposal",
      createdByUserId: USER,
      ...extra,
    })
    .returning();
  return row;
}

function places(n: number, category: string) {
  return Array.from({ length: n }, (_, i) => ({
    place_id: `place-${category}-${i}`,
    name: `${category} ${i}`,
    website: `https://${category.replace(/\W/g, "")}${i}.com.br`,
    address: `Rua ${i}, Sao Paulo`,
    category,
    phone: "+55 11 3000-0000",
  }));
}

const identity = { orgId: ORG, userId: USER, runId: RUN };
const page = (id: string, q = "") => request(app).get(`/orgs/audiences/${id}/preview/companies${q}`).set(getAuthHeaders());

beforeEach(async () => {
  fetchSpy.mockReset();
  companyCalls.length = 0;
  judgeCalls.length = 0;
  gm.places = [];
  gm.searches = 0;
  gm.drafts = 0;
  kindOf = () => ({ industry: "restaurants", title: "Owner" });
  targetIndustry = "restaurants";
  vi.stubGlobal("fetch", fetchSpy);
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  process.env.COSTS_SERVICE_URL = "http://costs:8080";
  clearPlatformPriceCache();
  route();
  await cleanTestData();
});

afterAll(async () => {
  globalThis.fetch = fetchBefore;
  await closeDb();
});

describe("preview companies: every company and person shown passed the shared fit judgment", () => {
  it("drops a company that is not the target's and a person whose function the target names as out, serves the next fitting ones", async () => {
    // 2 = a brewery, 3 = an HR tech company, 5 = a restaurant whose shown person is an HR manager.
    kindOf = (r) =>
      r === 2 ? { industry: "breweries", title: "CEO" }
      : r === 3 ? { industry: "human resources", title: "Co-founder" }
      : r === 5 ? { industry: "restaurants", title: "Human Resources Manager" }
      : { industry: "restaurants", title: "Owner" };
    const a = await createAudience();

    const res = await page(a.id, "?limit=10");
    expect(res.status).toBe(200);
    const names = res.body.rows.map((r: { company: { name: string } }) => r.company.name);
    expect(names).not.toContain("Company 2");
    expect(names).not.toContain("Company 3");
    expect(names).not.toContain("Company 5");
    expect(names).toEqual(["Company 1", "Company 4", "Company 6", "Company 7", "Company 8", "Company 9", "Company 10", "Company 11", "Company 12", "Company 13"]);
    expect(res.body.rows.every((r: { person: { title: string } }) => r.person.title === "Owner")).toBe(true);

    // Judged once, stored: a reload asks the judge nothing.
    const judged = await db.select().from(audienceFitJudgments).where(eq(audienceFitJudgments.audienceId, a.id));
    expect(judged.length).toBe(judgeCalls.length);
    const before = judgeCalls.length;
    const again = await page(a.id, "?limit=10");
    expect(again.body.rows.map((r: { company: { name: string } }) => r.company.name)).toEqual(names);
    expect(judgeCalls.length).toBe(before);
    // The judge saw the target text verbatim and the person's title.
    expect(judgeCalls[0]).toMatchObject({ targetAudience: RESTAURANTS });
  });

  it("hides a row stored before the judgment existed once it is judged out", async () => {
    const a = await createAudience();
    await db.insert(audiencePreviewCompanies).values([
      { audienceId: a.id, idx: 0, company: { name: "Old Restaurant", industry: "restaurants" }, person: { firstName: "A", title: "Owner", providerPersonId: "p0" } },
      { audienceId: a.id, idx: 1, company: { name: "Old Caterer", industry: "restaurants" }, person: { firstName: "B", title: "HR Manager", providerPersonId: "p1" } },
    ]);
    await db.update(audiences).set({ previewCompaniesState: { apolloOffset: 2, done: true } }).where(eq(audiences.id, a.id));
    const res = await page(a.id, "?limit=10");
    expect(res.body.rows.map((r: { company: { name: string } }) => r.company.name)).toEqual(["Old Restaurant"]);
    expect(res.body.totalAvailable).toBe(1);
  });
});

describe("provider choice: the provider with the most fitting companies per dollar sources the audience", () => {
  it("restaurants: Google Maps finds them cheaper than Apollo's tags, the audience becomes a Google Maps list with its trace", async () => {
    kindOf = (r) => (r % 2 === 0 ? { industry: "food production", title: "Owner" } : { industry: "restaurants", title: "Owner" });
    gm.places = places(20, "restaurants");
    const a = await createAudience({ chooserTrace: pendingProviderChoice() });

    const chosen = await ensureProviderChoice(a, identity);
    expect(chosen.provider).toBe("google_maps");
    expect((chosen.filters as { google_maps: { queries: string[] } }).google_maps.queries).toContain("restaurants in Sao Paulo");
    const trace = (chosen.chooserTrace as { providerChoice: Record<string, unknown> }).providerChoice as {
      status: string;
      chosen: string;
      candidates: ProviderSampleResult[];
    };
    expect(trace.status).toBe("decided");
    expect(trace.chosen).toBe("google_maps");
    const apollo = trace.candidates.find((c) => c.provider === "apollo")!;
    const maps = trace.candidates.find((c) => c.provider === "google_maps")!;
    expect(apollo).toMatchObject({ status: "measured", sampled: 10, fits: 5, fitRate: 0.5 });
    expect(apollo.unitCostUsd).toBeCloseTo(0.0276, 4);
    expect(maps).toMatchObject({ status: "measured", sampled: 10, fits: 10, fitRate: 1 });
    expect(maps.unitCostUsd).toBeCloseTo((150 * 0.000001) / 20, 9);
    expect(maps.samples[0]).toMatchObject({ company: "restaurants 0", companyFit: "in_target", personFit: "no_person" });

    // The losing provider's rows are gone; the preview is the businesses the sample already
    // found and judged: no new search, no new judgment.
    const searches = gm.searches;
    const judged = judgeCalls.length;
    const res = await page(a.id, "?limit=5");
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(5);
    expect(res.body.rows[0].company).toMatchObject({ name: "restaurants 0", industry: "restaurants", location: "Rua 0, Sao Paulo" });
    expect(res.body.rows[0].person).toEqual({ firstName: null, lastNameObfuscated: null, title: null, linkedinUrl: null });
    expect(gm.searches).toBe(searches);
    expect(judgeCalls.length).toBe(judged);

    // Decided once: asking again measures nothing.
    const again = await ensureProviderChoice(chosen, identity);
    expect(again.provider).toBe("google_maps");
    expect(gm.drafts).toBe(1);
  });

  it("SaaS: Google Maps finds no company of the target, Apollo keeps the audience and its sample is the preview's first rows", async () => {
    targetIndustry = "software";
    kindOf = () => ({ industry: "computer software", title: "CEO" });
    gm.places = places(20, "coworking space");
    const a = await createAudience({
      chooserTrace: pendingProviderChoice(),
      targetText: "Founders of SaaS companies in France with 10 to 200 employees.",
      nlPrompt: "Founders of SaaS companies in France with 10 to 200 employees.",
    });

    const chosen = await ensureProviderChoice(a, identity);
    expect(chosen.provider).toBe("apollo");
    const trace = (chosen.chooserTrace as { providerChoice: { chosen: string; candidates: ProviderSampleResult[] } }).providerChoice;
    expect(trace.chosen).toBe("apollo");
    expect(trace.candidates.find((c) => c.provider === "google_maps")).toMatchObject({ fits: 0, costPerFitUsd: null });
    expect(trace.candidates.find((c) => c.provider === "apollo")).toMatchObject({ fits: 10, sampled: 10 });

    const calls = companyCalls.length;
    const res = await page(a.id, "?limit=10");
    expect(res.body.rows).toHaveLength(10);
    expect(res.body.rows[0].company.name).toBe("Company 1");
    expect(companyCalls.length).toBe(calls); // the sample's rows, never paid twice
  });

  it("an audience born without the marker is never re-sourced", async () => {
    const a = await createAudience();
    const out = await ensureProviderChoice(a, identity);
    expect(out.provider).toBe("apollo");
    expect(companyCalls.length).toBe(0);
    expect(gm.drafts).toBe(0);
  });

  it("the first preview of a proposed audience waits for its provider choice", async () => {
    gm.places = places(20, "restaurants");
    kindOf = () => ({ industry: "breweries", title: "Owner" });
    const a = await createAudience({ chooserTrace: pendingProviderChoice() });
    const res = await page(a.id, "?limit=3");
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { company: { name: string } }) => r.company.name)).toEqual(["restaurants 0", "restaurants 1", "restaurants 2"]);
    const [row] = await db.select().from(audiences).where(eq(audiences.id, a.id));
    expect(row.provider).toBe("google_maps");
  });
});

describe("pickProvider", () => {
  const r = (provider: string, fits: number, sampled: number, unit: number): ProviderSampleResult => ({
    provider,
    status: "measured",
    sampled,
    fits,
    fitRate: sampled ? fits / sampled : null,
    unitCostUsd: unit,
    sampleCostUsd: 0,
    costPerFitUsd: fits > 0 ? unit / (fits / sampled) : null,
    costBasis: "",
    samples: [],
    error: null,
  });
  it("picks the lowest cost per fitting company", () => {
    expect(pickProvider([r("apollo", 9, 10, 0.03), r("google_maps", 2, 10, 0.001)])?.provider).toBe("google_maps");
    expect(pickProvider([r("apollo", 9, 10, 0.001), r("google_maps", 2, 10, 0.001)])?.provider).toBe("apollo");
  });
  it("no provider with a fitting company = no winner", () => {
    expect(pickProvider([r("apollo", 0, 10, 0.03), r("google_maps", 0, 10, 0.001)])).toBeNull();
  });
  it("a tie on cost goes to the higher fit rate", () => {
    expect(pickProvider([r("apollo", 5, 10, 0), r("google_maps", 8, 10, 0)])?.provider).toBe("google_maps");
  });
});
