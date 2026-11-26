import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// The shared fit judgment (audience-fit.ts) has its own suite (audience-source-by-fit.test.ts):
// here every business is one of the target's.
vi.mock("../../src/services/audience-fit.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-fit.js")>()),
  judgeAudienceFit: vi.fn(async (args: { subjects: Array<{ key: string }> }) =>
    args.subjects.map((s) => ({ key: s.key, companyFit: "in_target", companyConfidence: 1, personFit: "no_person", personConfidence: 1, companyPasses: true, passes: true }))
  ),
}));
// The offer-audience walk's free gates (opt-outs, won, bounces) have their own suites: nobody is excluded here.
vi.mock("../../src/services/opt-outs.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/opt-outs.js")>()),
  isPersonOptedOut: async () => false,
  loadServeExclusions: async () => ({ emails: new Set(), linkedinUrls: new Set(), personIds: new Set() }),
  isEmailWonForRequest: async () => false,
}));
vi.mock("../../src/services/bounces.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/bounces.js")>()),
  isEmailBounced: async () => false,
}));
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences, googleMapsCoverageRounds, googleMapsQueries } from "../../src/db/schema.js";
import type { CoverageDraftInput } from "../../src/lib/google-maps-coverage-draft.js";

// GMAPS-COVERAGE-1126: a Google Maps list whose searches all ran keeps finding businesses (finer searches where a
// search hit the provider's result ceiling, towns of the target region not searched yet) and says exhausted only once
// the region is covered: the model says so, writes nothing new, or a whole round of its searches found nothing new.

const app = createTestApp();
const ORG = "00000000-0000-4000-8000-0000000000a1";
const BRAND = "00000000-0000-4000-8000-0000000000b1";
const OTHER_BRAND = "00000000-0000-4000-8000-0000000000b2";
const SERVE_RUN = "00000000-0000-4000-8000-00000000fe01";

const fetchBefore = globalThis.fetch;
const envBefore = { ...process.env };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}
let calls: Call[] = [];
// place results per search query; WhatsApp verdict per phone.
let placesByQuery: Record<string, unknown[]> = {};
// litescrape rows per query (absent = a free miss: treg's route answers)
let cheapestByQuery: Record<string, unknown[]> = {};
let whatsapp: Record<string, { reachable: true } | { reachable: false; code: string; error: string }> = {};
let costId = 0;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

async function route(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? "GET";
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  calls.push({ url, method, headers, body });
  if (url.startsWith("http://keys/keys/treg/decrypt")) return json(200, { key: "treg-token", keySource: "platform" });
  if (url.startsWith("http://keys/keys/treg-org/decrypt")) return json(200, { key: "treg-org", keySource: "platform" });
  if (url === "http://runs/v1/runs" && method === "POST") return json(200, { id: "child-run-1" });
  if (/^http:\/\/runs\/v1\/runs\/[^/]+\/costs$/.test(url)) return json(200, { costs: [{ id: `cost-${++costId}` }] });
  if (/^http:\/\/runs\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(url)) return json(200, {});
  if (/^http:\/\/runs\/v1\/runs\/[^/]+$/.test(url) && method === "PATCH") return json(200, {});
  if (url === "http://billing/v1/customer_balance/authorize") return json(200, { sufficient: true });
  if (url.startsWith("https://treg.to/call/litescrape.google.serp.maps?")) {
    const rows = cheapestByQuery[String(new URL(url).searchParams.get("q"))];
    if (!rows) return json(404, { error: "no result" });
    return json(200, { local_results: rows }, { "x-treg-cost-micro": "150", "x-treg-served-by": "litescrape.google.serp.maps" });
  }
  if (url === "https://treg.to/call/treg.google.serp.maps") {
    const q = String(body?.q);
    const places = placesByQuery[q] ?? [];
    return json(200, { output: { places, count: places.length }, _treg: {} }, { "x-treg-cost-micro": "150", "x-treg-served-by": "crawl4ai.google.serp.maps" });
  }
  if (url === "http://crm/orgs/whatsapp/reach") {
    return json(200, whatsapp[String(body?.phone)] ?? { reachable: true });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
}

function place(id: string, name: string, phone: string | undefined, website?: string) {
  return {
    place_id: id,
    name,
    phone,
    website,
    address: `Kenesary St 20, Astana 010000, Kazakhstan`,
    category: "Restaurant",
    categories: ["Restaurant"],
  };
}

const FILTERS = { google_maps: { queries: ["restaurants in Astana", "cafes in Astana"], country: "kz", language: "en" } };

type Drive = (input: CoverageDraftInput) => Promise<{ covered: boolean; reason: string; queries: string[] }>;
let drafts: CoverageDraftInput[] = [];
function driveCoverage(fn: Drive) {
  (globalThis as { gmapsCoverageDraft?: unknown }).gmapsCoverageDraft = async (input: CoverageDraftInput) => {
    drafts.push(input);
    return fn(input);
  };
}

beforeEach(async () => {
  await cleanTestData();
  drafts = [];
  delete (globalThis as { gmapsCoverageDraft?: unknown }).gmapsCoverageDraft;
  calls = [];
  placesByQuery = {};
  cheapestByQuery = {};
  whatsapp = {};
  costId = 0;
  Object.assign(process.env, {
    KEY_SERVICE_URL: "http://keys",
    KEY_SERVICE_API_KEY: "k",
    RUNS_SERVICE_URL: "http://runs",
    RUNS_SERVICE_API_KEY: "k",
    BILLING_SERVICE_URL: "http://billing",
    BILLING_SERVICE_API_KEY: "k",
    CRM_SERVICE_URL: "http://crm",
    CRM_SERVICE_API_KEY: "k",
  });
  vi.stubGlobal("fetch", vi.fn(route));
});

afterAll(async () => {
  delete (globalThis as { gmapsCoverageDraft?: unknown }).gmapsCoverageDraft;
  globalThis.fetch = fetchBefore;
  for (const k of ["KEY_SERVICE_URL", "KEY_SERVICE_API_KEY", "RUNS_SERVICE_URL", "RUNS_SERVICE_API_KEY", "BILLING_SERVICE_URL", "BILLING_SERVICE_API_KEY", "CRM_SERVICE_URL", "CRM_SERVICE_API_KEY"]) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
  await closeDb();
});

function headers(extra: Record<string, string> = {}) {
  return { ...getAuthHeaders(), "x-org-id": ORG, "x-run-id": SERVE_RUN, "x-feature-slug": "sourcing-google-maps", ...extra };
}

async function createAudience(brandId = BRAND, name = "Restaurants in Astana") {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(headers())
    .send({ name, brandId, provider: "google_maps", nlPrompt: "restaurants and cafes in Astana", filters: FILTERS });
  expect(res.status).toBe(201);
  return res.body.audience as { id: string; channels: Array<{ list: string }> };
}

const serve = (audienceId: string) => request(app).post(`/orgs/audiences/${audienceId}/serve-next`).set(headers()).send({ reachableBy: "phone" });

describe("Google Maps coverage — serve-next", () => {
  it("all drafted searches ran: finer searches for the one at the ceiling + new towns, not exhausted", async () => {
    // "restaurants in Astana" answers 3 places = the most this provider ever answered (its ceiling); "cafes" 1.
    placesByQuery["restaurants in Astana"] = [place("ChIJ-a", "A", "+7 701 000 0001"), place("ChIJ-b", "B", "+7 701 000 0002"), place("ChIJ-c", "C", "+7 701 000 0003")];
    placesByQuery["cafes in Astana"] = [place("ChIJ-d", "D", "+7 701 000 0004")];
    placesByQuery["restaurants in Esil district Astana"] = [place("ChIJ-e", "E", "+7 701 000 0005")];
    placesByQuery["restaurants in Karaganda"] = [place("ChIJ-f", "F", "+7 701 000 0006")];
    driveCoverage(async (input) =>
      drafts.length === 1
        ? { covered: false, reason: "Astana restaurants cut at the ceiling, Karaganda not searched", queries: ["restaurants in Esil district Astana", "Restaurants in Astana", "restaurants in Karaganda"] }
        : { covered: true, reason: "every town searched", queries: [] }
    );
    const audience = await createAudience();
    const served: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await serve(audience.id);
      expect(res.body.status).toBe("served");
      served.push(res.body.person.providerPersonId);
    }
    expect(drafts).toHaveLength(0);
    // The drafted searches are spent: the walk asks for the next ones instead of answering exhausted.
    const fifth = await serve(audience.id);
    expect(fifth.body.status).toBe("served");
    expect(fifth.body.person.providerPersonId).toBe("ChIJ-e");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].regionText).toBe("restaurants and cafes in Astana");
    expect(drafts[0].searches).toEqual([
      { query: "restaurants in Astana", places: 3, newPlaces: 3, atCeiling: true },
      { query: "cafes in Astana", places: 1, newPlaces: 1, atCeiling: false },
    ]);
    expect(drafts[0].towns).toEqual([{ town: "Astana", places: 4 }]);
    const sixth = await serve(audience.id);
    expect(sixth.body.person.providerPersonId).toBe("ChIJ-f");
    // A repeat of a search already run (any case) is never stored twice.
    const queries = await db.select().from(googleMapsQueries).where(eq(googleMapsQueries.audienceId, audience.id));
    expect(queries.map((q) => [q.query, q.coverageRound]).sort()).toEqual([
      ["cafes in Astana", 0],
      ["restaurants in Astana", 0],
      ["restaurants in Esil district Astana", 1],
      ["restaurants in Karaganda", 1],
    ]);
    // Round 1 found new places, so the model is asked again; it says covered: now exhausted, reason kept.
    const end = await serve(audience.id);
    expect(end.body.status).toBe("exhausted");
    expect(drafts).toHaveLength(2);
    const rounds = await db.select().from(googleMapsCoverageRounds).where(eq(googleMapsCoverageRounds.audienceId, audience.id));
    expect(rounds.map((r) => [r.round, r.status, r.reason]).sort()).toEqual([
      [1, "extended", "Astana restaurants cut at the ceiling, Karaganda not searched"],
      [2, "covered", "every town searched"],
    ]);
    const [row] = await db.select().from(audiences).where(eq(audiences.id, audience.id));
    expect(row.reachableCount).toBe(6);
    // Covered is final: no new model call.
    expect((await serve(audience.id)).body.status).toBe("exhausted");
    expect(drafts).toHaveLength(2);
  });

  it("a round whose searches found no new place ends the list without asking the model again", async () => {
    placesByQuery["restaurants in Astana"] = [place("ChIJ-a", "A", "+7 701 000 0001")];
    placesByQuery["restaurants near Astana"] = [place("ChIJ-a", "A", "+7 701 000 0001")];
    driveCoverage(async () => ({ covered: false, reason: "suburbs", queries: ["restaurants near Astana"] }));
    const audience = await createAudience();
    expect((await serve(audience.id)).body.status).toBe("served");
    const end = await serve(audience.id);
    expect(end.body.status).toBe("exhausted");
    expect(drafts).toHaveLength(1);
    const rounds = await db.select().from(googleMapsCoverageRounds).where(eq(googleMapsCoverageRounds.audienceId, audience.id));
    expect(rounds.find((r) => r.round === 2)).toMatchObject({ status: "covered", reason: "round 1 (1 searches) found no new place" });
  });

  it("a model that writes only searches already run ends the list", async () => {
    driveCoverage(async () => ({ covered: false, reason: "more", queries: ["cafes in Astana"] }));
    const audience = await createAudience();
    expect((await serve(audience.id)).body.status).toBe("exhausted");
    const [round] = await db.select().from(googleMapsCoverageRounds).where(eq(googleMapsCoverageRounds.audienceId, audience.id));
    expect(round).toMatchObject({ round: 1, status: "covered", reason: "the model wrote no search not already run" });
  });

  it("a failed draft is a 502 and leaves no claim: the next serve asks again", async () => {
    driveCoverage(async () => {
      throw new Error("chat down");
    });
    const audience = await createAudience();
    const res = await serve(audience.id);
    expect(res.status).toBe(502);
    expect(await db.select().from(googleMapsCoverageRounds)).toEqual([]);
  });
});

describe("Google Maps coverage — a brand list walked by an offer audience", () => {
  it("the list holds no text: the region is the offer audience's, and the walk goes on past the drafted searches", async () => {
    placesByQuery["Drogerie in St. Gallen"] = [place("ChIJ-sg", "Drogerie SG", "+41 71 222 33 44")];
    placesByQuery["Drogerie in Wil SG"] = [place("ChIJ-wil", "Drogerie Wil", "+41 71 911 22 33")];
    driveCoverage(async () => ({ covered: false, reason: "canton towns", queries: ["Drogerie in Wil SG"] }));
    const list = await request(app)
      .post("/orgs/audiences")
      .set(headers())
      .send({ name: "SG drugstores (Maps)", brandId: BRAND, provider: "google_maps", role: "search", filters: { google_maps: { queries: ["Drogerie in St. Gallen"], country: "ch", language: "de" } } });
    expect(list.status).toBe(201);
    const realign = await request(app)
      .post("/internal/offer-audiences/realign")
      .set(getAuthHeaders())
      .send({ reason: "gmaps-coverage-test", orgId: ORG, brandId: BRAND, offers: [{ offerId: "00000000-0000-4000-8000-0000000000d1", name: "Drugstores", text: "Independent drugstores in the canton of St. Gallen" }], searchAudienceIds: [] });
    expect(realign.status).toBe(200);
    const target = (await db.select().from(audiences)).find((r) => r.role === "target")!;
    const next = () => request(app).post(`/orgs/audiences/${target.id}/candidates/next`).set(headers()).send({ reachableBy: "phone" });
    const first = await next();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.status).toBe("candidate");
    expect(first.body.candidate.providerPersonId ?? first.body.candidate.id).toBeTruthy();
    const second = await next();
    expect(second.body.status).toBe("candidate");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].regionText).toBe("Independent drugstores in the canton of St. Gallen");
    const queries = await db.select().from(googleMapsQueries).where(eq(googleMapsQueries.audienceId, list.body.audience.id));
    expect(queries.map((q) => q.query).sort()).toEqual(["Drogerie in St. Gallen", "Drogerie in Wil SG"]);
  });
});
