import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences, googleMapsBrandClaims, googleMapsPlaces, googleMapsQueries, leadServes } from "../../src/db/schema.js";
import { cityOfAddress, toE164, businessDomain } from "../../src/services/google-maps-source.js";

// GMAPS-SOURCE-1103: a Google Maps audience serves local businesses found on
// Google Maps through treg (metered on a child run of the serve's run), each
// business at most once per brand, a number crm-service says is not on WhatsApp
// never served to a WhatsApp pipe, and a truthful end once every search ran.

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

beforeEach(async () => {
  await cleanTestData();
  calls = [];
  placesByQuery = {};
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

async function serve(audienceId: string, body: Record<string, unknown> = {}, extra: Record<string, string> = {}) {
  return request(app).post(`/orgs/audiences/${audienceId}/serve-next`).set(headers(extra)).send(body);
}

describe("Google Maps source — serve-next", () => {
  it("serves a business with its E.164 phone, website and address; no email, no person name; cost declared on a child run", async () => {
    placesByQuery["restaurants in Astana"] = [place("ChIJ-a", "Line Brew Astana", "+7 701 155 1322", "https://linebrew.kz/menu")];
    const audience = await createAudience();
    expect(audience.channels[0]?.list).toBe("google_maps_search");

    const res = await serve(audience.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    const p = res.body.person;
    expect(p.email).toBeNull();
    expect(p.firstName).toBeNull();
    expect(p.lastName).toBeNull();
    expect(p.name).toBeNull();
    expect(p.phone).toBe("+77011551322");
    expect(p.provider).toBe("google_maps");
    expect(p.providerPersonId).toBe("ChIJ-a");
    expect(p.organization.name).toBe("Line Brew Astana");
    expect(p.organization.domain).toBe("linebrew.kz");
    expect(p.organization.websiteUrl).toBe("https://linebrew.kz/menu");
    expect(p.organization.streetAddress).toBe("Kenesary St 20, Astana 010000, Kazakhstan");
    expect(p.organization.city).toBe("Astana");
    expect(p.organization.country).toBe("Kazakhstan");
    expect(p.organization.primaryPhone).toBe("+77011551322");
    expect(typeof res.body.personId).toBe("string");

    // Metered: a child run under the serve's run, the ceiling provisioned then cancelled, treg's charge as actual.
    const runOpen = calls.find((c) => c.url === "http://runs/v1/runs");
    expect(runOpen?.headers["x-run-id"]).toBe(SERVE_RUN);
    expect(runOpen?.body).toMatchObject({ serviceName: "human-service", taskName: "google-maps-search" });
    const costs = calls.filter((c) => c.url === "http://runs/v1/runs/child-run-1/costs").map((c) => (c.body!.items as Array<Record<string, unknown>>)[0]);
    expect(costs).toEqual([
      expect.objectContaining({ costName: "treg-micro-usd", costSource: "platform", quantity: 5000, status: "provisioned" }),
      expect.objectContaining({ costName: "treg-micro-usd", costSource: "platform", quantity: 150 }),
    ]);
    expect(costs[1]).not.toHaveProperty("status");
    expect(calls.some((c) => c.url === "http://runs/v1/runs/child-run-1/costs/cost-1" && c.body?.status === "cancelled")).toBe(true);
    const treg = calls.find((c) => c.url.startsWith("https://treg.to"));
    expect(treg?.headers["x-treg-route-max-cost"]).toBe("0.005000");
    expect(treg?.body).toEqual({ q: "restaurants in Astana", country: "kz", language: "en" });
    const [q] = await db.select().from(googleMapsQueries).where(eq(googleMapsQueries.query, "restaurants in Astana"));
    expect(q.runId).toBe("child-run-1");
    expect(q.chargedMicro).toBe(150);
    const [serveRow] = await db.select().from(leadServes);
    expect(serveRow).toMatchObject({ provider: "google_maps", providerPersonId: "ChIJ-a", runId: SERVE_RUN, email: null });
  });

  it("never serves the same business twice to a brand (same place under another audience, or same phone), another brand still gets it", async () => {
    placesByQuery["restaurants in Astana"] = [
      place("ChIJ-a", "Line Brew", "+7 701 155 1322"),
      place("ChIJ-b", "Line Brew (2nd entrance)", "+77011551322"),
      place("ChIJ-c", "The Kitchen", "+7 701 800 7718"),
    ];
    const first = await createAudience();
    const second = await createAudience(BRAND, "Cafes in Astana");

    const s1 = await serve(first.id);
    expect(s1.body.person.providerPersonId).toBe("ChIJ-a");
    // Same phone, other place: taken; next business served.
    const s2 = await serve(first.id);
    expect(s2.body.person.providerPersonId).toBe("ChIJ-c");
    // The second audience of the same brand finds the same places: all taken, then its other search finds none.
    const s3 = await serve(second.id);
    expect(s3.body.status).toBe("exhausted");
    const [secondRow] = await db.select().from(audiences).where(eq(audiences.id, second.id));
    expect(secondRow.reachableCount).toBe(0);
    // Another brand of the org: its own claim.
    const other = await createAudience(OTHER_BRAND, "Restaurants in Astana");
    const s4 = await serve(other.id);
    expect(s4.body.person.providerPersonId).toBe("ChIJ-a");
    expect(s4.body.personId).toBe(s1.body.personId);
    const claims = await db.select().from(googleMapsBrandClaims);
    expect(claims.filter((c) => c.brandId === BRAND).map((c) => c.placeId).sort()).toEqual(["ChIJ-a", "ChIJ-c"]);
  });

  it("serves to a WhatsApp pipe only a number crm-service says is on WhatsApp; the other is never claimed", async () => {
    placesByQuery["restaurants in Astana"] = [place("ChIJ-a", "No WhatsApp", "+7 701 155 1322"), place("ChIJ-c", "On WhatsApp", "+7 701 800 7718")];
    whatsapp["+77011551322"] = { reachable: false, code: "not_on_whatsapp", error: "+77011551322 is not on WhatsApp." };
    const audience = await createAudience();
    const res = await serve(audience.id, { reachableBy: "phone", reachableOn: ["whatsapp"] });
    expect(res.body.status).toBe("served");
    expect(res.body.person.providerPersonId).toBe("ChIJ-c");
    const asked = calls.filter((c) => c.url === "http://crm/orgs/whatsapp/reach").map((c) => c.body);
    expect(asked).toEqual([{ brandId: BRAND, phone: "+77011551322" }, { brandId: BRAND, phone: "+77018007718" }]);
    const claims = await db.select().from(googleMapsBrandClaims);
    expect(claims.map((c) => c.placeId)).toEqual(["ChIJ-c"]);
    const [skipped] = await db.select().from(googleMapsPlaces).where(eq(googleMapsPlaces.placeId, "ChIJ-a"));
    expect(skipped.status).toBe("not_on_whatsapp");
  });

  it("skips for good a business the brand stated is not theirs, serves the next, never exhausts on it", async () => {
    placesByQuery["restaurants in Astana"] = [place("ChIJ-a", "Not ours", "+7 701 155 1322"), place("ChIJ-c", "Next one", "+7 701 800 7718")];
    whatsapp["+77011551322"] = { reachable: false, code: "stated_not_to_brand", error: "The brand stated this person is not someone of the brand." };
    const audience = await createAudience();
    const res = await serve(audience.id, { reachableBy: "phone", reachableOn: ["whatsapp"] });
    expect(res.body.status).toBe("served");
    expect(res.body.person.providerPersonId).toBe("ChIJ-c");
    const [skipped] = await db.select().from(googleMapsPlaces).where(eq(googleMapsPlaces.placeId, "ChIJ-a"));
    expect(skipped.status).toBe("stated_not_to_brand");
    const claims = await db.select().from(googleMapsBrandClaims);
    expect(claims.map((c) => c.placeId)).toEqual(["ChIJ-c"]);
    // Never offered again: the next serve does not ask crm-service about it.
    calls.length = 0;
    await serve(audience.id, { reachableBy: "phone", reachableOn: ["whatsapp"] });
    expect(calls.some((c) => c.url === "http://crm/orgs/whatsapp/reach" && c.body?.phone === "+77011551322")).toBe(false);
  });

  for (const code of ["whatsapp_not_linked", "whatsapp_not_connected", "automation_not_allowed", "no_phone_known", "person_replied", "human_in_conversation"]) {
    it(`keeps today's behaviour on ${code}: nobody consumed, exhausted`, async () => {
      placesByQuery["restaurants in Astana"] = [place("ChIJ-a", "Line Brew", "+7 701 155 1322"), place("ChIJ-c", "Next one", "+7 701 800 7718")];
      whatsapp["+77011551322"] = { reachable: false, code, error: code };
      const audience = await createAudience();
      const res = await serve(audience.id, { reachableOn: ["whatsapp"] });
      expect(res.body.status).toBe("exhausted");
      const [row] = await db.select().from(googleMapsPlaces).where(eq(googleMapsPlaces.placeId, "ChIJ-a"));
      expect(row.status).toBe("waiting");
      expect(await db.select().from(googleMapsBrandClaims)).toHaveLength(0);
    });
  }

  it("consumes nobody when the brand itself cannot send on WhatsApp", async () => {
    placesByQuery["restaurants in Astana"] = [place("ChIJ-a", "Line Brew", "+7 701 155 1322")];
    whatsapp["+77011551322"] = { reachable: false, code: "whatsapp_not_linked", error: "no linked account" };
    const audience = await createAudience();
    const res = await serve(audience.id, { reachableOn: ["whatsapp"] });
    expect(res.body.status).toBe("exhausted");
    const [row] = await db.select().from(googleMapsPlaces);
    expect(row.status).toBe("waiting");
    expect(await db.select().from(googleMapsBrandClaims)).toHaveLength(0);
  });

  it("skips a business with no valid phone, and ends truthfully once every search ran", async () => {
    placesByQuery["restaurants in Astana"] = [place("ChIJ-x", "No phone", undefined), place("ChIJ-a", "Line Brew", "+7 701 155 1322")];
    const audience = await createAudience();
    expect((await serve(audience.id)).body.person.providerPersonId).toBe("ChIJ-a");
    const end = await serve(audience.id);
    expect(end.body).toEqual({ status: "exhausted", person: null });
    const queries = await db.select().from(googleMapsQueries).where(eq(googleMapsQueries.audienceId, audience.id));
    expect(queries.every((q) => q.ranAt !== null)).toBe(true);
    expect(calls.filter((c) => c.url.startsWith("https://treg.to"))).toHaveLength(2);
    const [row] = await db.select().from(audiences).where(eq(audiences.id, audience.id));
    expect(row.reachableCount).toBe(1);
    // A later serve runs no search again.
    await serve(audience.id);
    expect(calls.filter((c) => c.url.startsWith("https://treg.to"))).toHaveLength(2);
  });

  it("an email pipe gets nobody and nothing is searched", async () => {
    const audience = await createAudience();
    const res = await serve(audience.id, { reachableBy: "email" });
    expect(res.body.status).toBe("exhausted");
    expect(calls.some((c) => c.url.startsWith("https://treg.to"))).toBe(false);
  });

  it("refuses a paid search without x-run-id (400)", async () => {
    const audience = await createAudience();
    const { "x-run-id": _drop, ...rest } = headers();
    const res = await request(app).post(`/orgs/audiences/${audience.id}/serve-next`).set(rest).send({});
    expect(res.status).toBe(400);
  });

  it("candidates/next answers 422 (serve-next is the path)", async () => {
    const audience = await createAudience();
    const res = await request(app).post(`/orgs/audiences/${audience.id}/candidates/next`).set(headers()).send({});
    expect(res.status).toBe(422);
  });

  it("still-fits answers a phone-only find (email null + phone)", async () => {
    placesByQuery["restaurants in Astana"] = [place("ChIJ-a", "Line Brew", "+7 701 155 1322")];
    const audience = await createAudience();
    await serve(audience.id);
    const fits = await request(app)
      .post("/internal/audiences/still-fits")
      .set(getAuthHeaders())
      .send({ orgId: ORG, brandId: BRAND, audienceId: audience.id, email: null, phone: "+77011551322" });
    expect(fits.status).toBe(200);
    expect(fits.body).toEqual({ fits: true, basis: "found_by_search" });
    const unknown = await request(app)
      .post("/internal/audiences/still-fits")
      .set(getAuthHeaders())
      .send({ orgId: ORG, brandId: BRAND, audienceId: audience.id, email: null, phone: "+77019999999" });
    expect(unknown.status).toBe(422);
  });
});

describe("Google Maps source — helpers", () => {
  it("reads phones in the audience's country, refuses invalid ones", () => {
    expect(toE164("+7 701 155 1322", "kz")).toBe("+77011551322");
    expect(toE164("8 701 155 1322", "kz")).toBe("+77011551322");
    expect(toE164("123", "kz")).toBeNull();
    expect(toE164(undefined, "kz")).toBeNull();
  });
  it("reads the city from the address only when it ends on the country", () => {
    expect(cityOfAddress("Kenesary St 20, Astana 010000, Kazakhstan", "Kazakhstan")).toBe("Astana");
    expect(cityOfAddress("Kenesary St 20", "Kazakhstan")).toBeNull();
  });
  it("a page on a hosting platform is no business domain", () => {
    expect(businessDomain("https://www.facebook.com/astanalinebrew/")).toBeNull();
    expect(businessDomain("https://astana.restoran.kz/restaurant/1")).toBe("restoran.kz");
  });
});
