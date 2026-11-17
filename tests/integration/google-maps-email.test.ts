import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { brandSuppressions, googleMapsBrandClaims, googleMapsPlaces, googleMapsSiteReads, leadServes } from "../../src/db/schema.js";
import { contactPageLinks, homepageOf, publishedEmails } from "../../src/services/google-maps-site-contact.js";

// GMAPS-EMAIL-1117: a Google Maps audience asked for EMAIL reach reads each
// business's own site (homepage + the contact / legal pages it links to, through
// treg, metered), serves the address the site publishes (verified, valid or
// catch-all), with the person the site names, and never an invented address or name.

const optedOut = new Set<string>();
const won = new Set<string>();
const bounced = new Set<string>();
vi.mock("../../src/services/opt-outs.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/opt-outs.js")>()),
  isPersonOptedOut: async (_i: unknown, e: string) => optedOut.has(e),
  isEmailWonForRequest: async (_i: unknown, e: string) => won.has(e),
}));
vi.mock("../../src/services/bounces.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/bounces.js")>()),
  isEmailBounced: async (_i: unknown, e: string) => bounced.has(e),
}));

const app = createTestApp();
const ORG = "00000000-0000-4000-8000-0000000000a1";
const BRAND = "00000000-0000-4000-8000-0000000000b1";
const SERVE_RUN = "00000000-0000-4000-8000-00000000fe01";

const fetchBefore = globalThis.fetch;
const ENV = {
  KEY_SERVICE_URL: "http://keys",
  KEY_SERVICE_API_KEY: "k",
  RUNS_SERVICE_URL: "http://runs",
  RUNS_SERVICE_API_KEY: "k",
  BILLING_SERVICE_URL: "http://billing",
  BILLING_SERVICE_API_KEY: "k",
  CRM_SERVICE_URL: "http://crm",
  CRM_SERVICE_API_KEY: "k",
  APOLLO_SERVICE_URL: "http://apollo",
  APOLLO_SERVICE_API_KEY: "k",
  CHAT_SERVICE_URL: "http://chat",
  CHAT_SERVICE_API_KEY: "k",
};
const envBefore: Record<string, string | undefined> = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}
let calls: Call[] = [];
let placesByQuery: Record<string, unknown[]> = {};
// page text + links per url (absent = treg answers 404 after its waterfall)
let site: Record<string, { text: string; links?: string[] }> = {};
let verdicts: Record<string, string> = {};
let pick: (message: string) => Record<string, unknown> = () => ({ email: null, name: null, role: null });
let costId = 0;
let runId = 0;

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
  if (url === "http://runs/v1/runs" && method === "POST") return json(200, { id: `child-run-${++runId}` });
  if (/^http:\/\/runs\/v1\/runs\/[^/]+\/costs$/.test(url)) return json(200, { costs: [{ id: `cost-${++costId}` }] });
  if (/^http:\/\/runs\/v1\/runs\/[^/]+\/costs\/[^/]+$/.test(url)) return json(200, {});
  if (/^http:\/\/runs\/v1\/runs\/[^/]+$/.test(url) && method === "PATCH") return json(200, {});
  if (url === "http://billing/v1/customer_balance/authorize") return json(200, { sufficient: true });
  if (url === "https://treg.to/call/treg.google.serp.maps") {
    const places = placesByQuery[String(body?.q)] ?? [];
    return json(200, { output: { places } }, { "x-treg-cost-micro": "150", "x-treg-served-by": "crawl4ai.google.serp.maps" });
  }
  if (url === "https://treg.to/call/treg.web.extract") {
    const page = site[String(body?.url)];
    if (!page) return json(404, { error: "no provider found the page" });
    return json(
      200,
      { output: { pages: [{ url: body?.url, final_url: body?.url, text: page.text, links: page.links ?? [] }] } },
      { "x-treg-cost-micro": "0", "x-treg-served-by": "tinyfish.web.fetch" }
    );
  }
  if (url === "http://chat/complete") return json(200, { json: pick(String(body?.message)) });
  if (url === "http://apollo/email-verifications") {
    const email = (body?.emails as string[])[0];
    const verdict = verdicts[email] ?? "valid";
    return json(200, { results: [{ email, verdict, deliverable: verdict === "valid" }] });
  }
  if (url === "http://crm/orgs/whatsapp/reach") return json(200, { reachable: true });
  throw new Error(`unexpected fetch ${method} ${url}`);
}

function place(id: string, name: string, phone: string | undefined, website?: string) {
  return { place_id: id, name, phone, website, address: "Saatlenstrasse 12, 8051 Zürich, Switzerland", category: "Drugstore" };
}

const FILTERS = { google_maps: { queries: ["Drogerie in Zürich"], country: "ch", language: "de" } };

beforeEach(async () => {
  await cleanTestData();
  calls = [];
  placesByQuery = {};
  site = {};
  verdicts = {};
  optedOut.clear();
  won.clear();
  bounced.clear();
  pick = () => ({ email: null, name: null, role: null });
  costId = 0;
  runId = 0;
  Object.assign(process.env, ENV);
  vi.stubGlobal("fetch", vi.fn(route));
});

afterAll(async () => {
  globalThis.fetch = fetchBefore;
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await closeDb();
});

function headers() {
  return { ...getAuthHeaders(), "x-org-id": ORG, "x-run-id": SERVE_RUN, "x-feature-slug": "sourcing-google-maps" };
}

async function createAudience(name = "Drugstores in Zürich") {
  const res = await request(app)
    .post("/orgs/audiences")
    .set(headers())
    .send({ name, brandId: BRAND, provider: "google_maps", nlPrompt: "drugstores in Zürich", filters: FILTERS });
  expect(res.status).toBe(201);
  return res.body.audience as { id: string };
}

async function serve(audienceId: string, body: Record<string, unknown> = { reachableBy: "email" }) {
  return request(app).post(`/orgs/audiences/${audienceId}/serve-next`).set(headers()).send(body);
}

// The drugstore of the live measurement: the address and the name are only on /impressum.
function schwamendingen() {
  site["https://drogerieschwamendingen.com/"] = {
    text: "# Drogerie im Schwamedingerhuus\n\nIhre Drogerie in Zürich.",
    links: ["https://drogerieschwamendingen.com/sortiment", "https://drogerieschwamendingen.com/impressum", "https://uxfive.ch/"],
  };
  site["https://drogerieschwamendingen.com/impressum"] = {
    text: "# Impressum\n\nEmail: info@drogerieschwamendingen.com\n\nGeschäftsinhaber:\n\nMarc Pfister\n\nKonzept: Roethlisberger Digital Marketing, hello@uxfive.ch",
  };
}

describe("Google Maps source — email reach", () => {
  it("serves the address published on the Impressum only, with the person the site names, verified", async () => {
    placesByQuery["Drogerie in Zürich"] = [place("ChIJ-s", "Drogerie Schwamedingerhuus", "044 322 44 46", "https://drogerieschwamendingen.com/kontakt")];
    schwamendingen();
    pick = (message) => {
      expect(message).toContain("info@drogerieschwamendingen.com");
      expect(message).toContain("hello@uxfive.ch");
      return { email: "info@drogerieschwamendingen.com", name: "Marc Pfister", role: "Geschäftsinhaber" };
    };
    const audience = await createAudience();
    const res = await serve(audience.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    const p = res.body.person;
    expect(p.email).toBe("info@drogerieschwamendingen.com");
    expect(p.firstName).toBe("Marc");
    expect(p.lastName).toBe("Pfister");
    expect(p.name).toBe("Marc Pfister");
    expect(p.title).toBe("Geschäftsinhaber");
    expect(p.phone).toBe("+41443224446");
    expect(p.organization.domain).toBe("drogerieschwamendingen.com");

    // Homepage then the Impressum (same site only, never the agency's).
    const read = calls.filter((c) => c.url === "https://treg.to/call/treg.web.extract").map((c) => c.body?.url);
    expect(read).toEqual(["https://drogerieschwamendingen.com/", "https://drogerieschwamendingen.com/impressum"]);
    // Metered: the site read on its own child run of the serve's run.
    const opened = calls.filter((c) => c.url === "http://runs/v1/runs").map((c) => c.body?.taskName);
    expect(opened).toEqual(["google-maps-search", "google-maps-site-read"]);
    const extract = calls.find((c) => c.url === "https://treg.to/call/treg.web.extract");
    expect(extract?.headers["x-treg-route-max-cost"]).toBe("0.001000");
    // Verified by apollo-service on the serve's run.
    const verify = calls.find((c) => c.url === "http://apollo/email-verifications");
    expect(verify?.body).toEqual({ emails: ["info@drogerieschwamendingen.com"], source: "google-maps" });
    expect(verify?.headers["x-run-id"]).toBe(SERVE_RUN);

    const [serveRow] = await db.select().from(leadServes);
    expect(serveRow).toMatchObject({ provider: "google_maps", email: "info@drogerieschwamendingen.com", emailVerdict: "valid", firstName: "Marc" });
    const [sup] = await db.select().from(brandSuppressions);
    expect(sup).toMatchObject({ brandId: BRAND, emailNorm: "info@drogerieschwamendingen.com" });
    const [stored] = await db.select().from(googleMapsSiteReads);
    expect(stored).toMatchObject({ placeId: "ChIJ-s", outcome: "found", contactName: "Marc Pfister" });
    expect(stored.emails).toEqual(["info@drogerieschwamendingen.com", "hello@uxfive.ch"]);
  });

  it("serves the address with no name when the site names nobody; a name the picker invents is dropped", async () => {
    placesByQuery["Drogerie in Zürich"] = [place("ChIJ-a", "Bio Laden", "044 111 22 33", "https://bioladen.ch")];
    site["https://bioladen.ch/"] = { text: "Willkommen. Schreiben Sie uns: hallo(at)bioladen.ch" };
    pick = () => ({ email: "hallo@bioladen.ch", name: "Anna Muster", role: "Inhaberin" });
    const audience = await createAudience();
    const res = await serve(audience.id);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("hallo@bioladen.ch");
    expect(res.body.person.name).toBeNull();
    expect(res.body.person.firstName).toBeNull();
    expect(res.body.person.title).toBeNull();
  });

  it("serves nobody by email when no page publishes an address; the business stays for a phone pipe; the site is never read twice", async () => {
    placesByQuery["Drogerie in Zürich"] = [place("ChIJ-n", "Silent Shop", "044 555 66 77", "https://silent.ch")];
    site["https://silent.ch/"] = { text: "Nur Telefon.", links: ["https://silent.ch/kontakt"] };
    site["https://silent.ch/kontakt"] = { text: "Telefon 044 555 66 77" };
    const audience = await createAudience();
    const res = await serve(audience.id);
    expect(res.body.status).toBe("exhausted");
    expect(calls.some((c) => c.url === "http://chat/complete")).toBe(false);
    expect(calls.some((c) => c.url === "http://apollo/email-verifications")).toBe(false);
    const [row] = await db.select().from(googleMapsPlaces);
    expect(row).toMatchObject({ status: "waiting", emailStatus: "no_email" });

    calls = [];
    expect((await serve(audience.id)).body.status).toBe("exhausted");
    expect(calls.some((c) => c.url === "https://treg.to/call/treg.web.extract")).toBe(false);

    // WhatsApp / phone behaviour unchanged: the phone pipe still gets it.
    const phone = await serve(audience.id, {});
    expect(phone.body.status).toBe("served");
    expect(phone.body.person.email).toBeNull();
    expect(phone.body.person.phone).toBe("+41445556677");
  });

  it("a business with no website is not served by email, and never read", async () => {
    placesByQuery["Drogerie in Zürich"] = [place("ChIJ-w", "No site", "044 555 66 77", undefined), place("ChIJ-f", "Facebook only", "044 555 66 78", "https://facebook.com/shop")];
    const audience = await createAudience();
    expect((await serve(audience.id)).body.status).toBe("exhausted");
    expect(calls.some((c) => c.url === "https://treg.to/call/treg.web.extract")).toBe(false);
    const rows = await db.select().from(googleMapsPlaces);
    expect(rows.map((r) => r.emailStatus)).toEqual(["no_website", "no_website"]);
  });

  it("an address the picker names but no page published is never served", async () => {
    placesByQuery["Drogerie in Zürich"] = [place("ChIJ-g", "Guess", "044 555 66 77", "https://guess.ch")];
    site["https://guess.ch/"] = { text: "Kontakt: shop@guess.ch" };
    pick = () => ({ email: "info@guess.ch", name: null, role: null });
    const audience = await createAudience();
    expect((await serve(audience.id)).body.status).toBe("exhausted");
    const [row] = await db.select().from(googleMapsPlaces);
    expect(row.emailStatus).toBe("no_email");
  });

  it("serves catch-all, never an invalid address", async () => {
    placesByQuery["Drogerie in Zürich"] = [place("ChIJ-i", "Invalid", "044 555 66 70", "https://bad.ch"), place("ChIJ-c", "Catch", "044 555 66 71", "https://catch.ch")];
    site["https://bad.ch/"] = { text: "info@bad.ch" };
    site["https://catch.ch/"] = { text: "info@catch.ch" };
    verdicts["info@bad.ch"] = "invalid";
    verdicts["info@catch.ch"] = "catch_all";
    pick = (m) => ({ email: m.includes("bad.ch") ? "info@bad.ch" : "info@catch.ch", name: null, role: null });
    const audience = await createAudience();
    const res = await serve(audience.id);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("info@catch.ch");
    expect(res.body.person.catchAll).toBe(true);
    const [bad] = await db.select().from(googleMapsPlaces).where(eq(googleMapsPlaces.placeId, "ChIJ-i"));
    expect(bad).toMatchObject({ emailStatus: "not_deliverable", emailVerdict: "invalid", status: "waiting" });
  });

  it("never serves a business already claimed for the brand, nor an address the brand already holds, nor an opted-out one", async () => {
    placesByQuery["Drogerie in Zürich"] = [
      place("ChIJ-s", "Drogerie Schwamedingerhuus", "044 322 44 46", "https://drogerieschwamendingen.com"),
      place("ChIJ-h", "Held", "044 555 66 72", "https://held.ch"),
      place("ChIJ-o", "Opted out", "044 555 66 73", "https://optout.ch"),
    ];
    schwamendingen();
    site["https://held.ch/"] = { text: "info@held.ch" };
    site["https://optout.ch/"] = { text: "info@optout.ch" };
    optedOut.add("info@optout.ch");
    await db.insert(googleMapsBrandClaims).values({ orgId: ORG, brandId: BRAND, placeId: "ChIJ-s", phoneE164: "+41443224446" });
    await db.insert(brandSuppressions).values({ orgId: ORG, brandId: BRAND, emailNorm: "info@held.ch", lastProvider: "apollo" });
    pick = (m) => ({ email: (m.match(/info@[a-z.]+/) ?? [null])[0], name: null, role: null });
    const audience = await createAudience();
    expect((await serve(audience.id)).body.status).toBe("exhausted");
    const rows = Object.fromEntries((await db.select().from(googleMapsPlaces)).map((r) => [r.placeId, r.status]));
    expect(rows).toEqual({ "ChIJ-s": "taken", "ChIJ-h": "taken", "ChIJ-o": "opted_out" });
    // The claimed business was never read.
    expect(calls.some((c) => String(c.body?.url ?? "").includes("drogerieschwamendingen"))).toBe(false);
  });
});

describe("Google Maps site contact — helpers", () => {
  it("reads the site's homepage from a deep link", () => {
    expect(homepageOf("https://www.shop.ch/menu?x=1")).toBe("https://www.shop.ch/");
    expect(homepageOf("shop.ch")).toBe("https://shop.ch/");
    expect(homepageOf(null)).toBeNull();
  });
  it("keeps the same site's contact pages, legal first, never another site's", () => {
    expect(
      contactPageLinks("https://shop.ch/", [
        "https://shop.ch/ueber-uns",
        "https://www.shop.ch/kontakt",
        "https://shop.ch/impressum",
        "https://agency.ch/contact",
        "https://shop.ch/sortiment",
        "mailto:info@shop.ch",
      ])
    ).toEqual(["https://shop.ch/impressum", "https://www.shop.ch/kontakt", "https://shop.ch/ueber-uns"]);
  });
  it("collects only published addresses (text, obfuscated, mailto), never an image name", () => {
    expect(
      publishedEmails([
        { text: "Mail: info@shop.ch. Or anna [at] shop [dot] ch. logo@2x.png", links: ["mailto:Shop@Shop.ch?subject=Hi"] },
      ])
    ).toEqual(["info@shop.ch", "anna@shop.ch", "shop@shop.ch"]);
  });
});
