import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// The shared fit judgment (audience-fit.ts) has its own suite (audience-source-by-fit.test.ts):
// here every business is one of the target's.
vi.mock("../../src/services/audience-fit.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-fit.js")>()),
  judgeAudienceFit: vi.fn(async (args: { subjects: Array<{ key: string }> }) =>
    args.subjects.map((s) => ({ key: s.key, companyFit: "in_target", companyConfidence: 1, personFit: "no_person", personConfidence: 1, companyPasses: true, passes: true }))
  ),
}));
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audienceCandidates, audiences, brandSuppressions, googleMapsBrandClaims, googleMapsPlaces, googleMapsQueries, googleMapsSiteReads, leadServes } from "../../src/db/schema.js";
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
  loadServeExclusions: async () => ({ emails: new Set(), linkedinUrls: new Set(), personIds: new Set() }),
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
// litescrape rows per query (absent = a free miss: treg's route answers)
let cheapestByQuery: Record<string, unknown[]> = {};
// page text + links per url (absent = treg answers 404 after its waterfall)
let site: Record<string, { text: string; links?: string[] }> = {};
// pages whose read gets no answer (treg's extract times out on them)
let timeoutUrls = new Set<string>();
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
  if (url.startsWith("https://treg.to/call/litescrape.google.serp.maps?")) {
    const rows = cheapestByQuery[String(new URL(url).searchParams.get("q"))];
    if (!rows) return json(404, { error: "no result" });
    return json(200, { local_results: rows }, { "x-treg-cost-micro": "150", "x-treg-served-by": "litescrape.google.serp.maps" });
  }
  if (url === "https://treg.to/call/treg.google.serp.maps") {
    const places = placesByQuery[String(body?.q)] ?? [];
    return json(200, { output: { places } }, { "x-treg-cost-micro": "150", "x-treg-served-by": "crawl4ai.google.serp.maps" });
  }
  if (url === "https://treg.to/call/treg.web.extract") {
    if (timeoutUrls.has(String(body?.url))) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
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
  cheapestByQuery = {};
  site = {};
  timeoutUrls = new Set();
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
    // No reach stated = email (GMAPS-LIVE-1117): still nobody.
    expect((await serve(audience.id, {})).body.status).toBe("exhausted");
    const phone = await serve(audience.id, { reachableBy: "phone" });
    expect(phone.body.status).toBe("served");
    expect(phone.body.person.email).toBeNull();
    expect(phone.body.person.phone).toBe("+41445556677");
  });

  it("a site that never answers skips that business only: the next one is served, the slow one is read again 3 days later (LIVINGVITAL-SOURCING-1121)", async () => {
    placesByQuery["Drogerie in Zürich"] = [
      place("ChIJ-slow", "Slow Apotheke", "044 999 00 00", "https://slow-apotheke.ch/"),
      place("ChIJ-a", "Bio Laden", "044 111 22 33", "https://bioladen.ch"),
    ];
    timeoutUrls.add("https://slow-apotheke.ch/");
    site["https://bioladen.ch/"] = { text: "Schreiben Sie uns: hallo@bioladen.ch" };
    pick = (message) => (message.includes("hallo@bioladen.ch") ? { email: "hallo@bioladen.ch", name: null, role: null } : { email: null, name: null, role: null });
    const audience = await createAudience();
    const res = await serve(audience.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("hallo@bioladen.ch");
    // Each page read is bounded at 20 s (a homepage + 3 pages stay under lead-service's 90 s).
    const slow = (await db.select().from(googleMapsPlaces).where(eq(googleMapsPlaces.placeId, "ChIJ-slow")))[0];
    expect(slow).toMatchObject({ status: "waiting", emailStatus: "site_unreadable" });
    // Nothing stored for the slow site: a later read may succeed.
    const stored = await db.select().from(googleMapsSiteReads);
    expect(stored.map((r) => r.placeId)).toEqual(["ChIJ-a"]);

    // Within 3 days the slow business is not tried again: no read, nothing left by email.
    calls = [];
    expect((await serve(audience.id)).body.status).toBe("exhausted");
    expect(calls.some((c) => c.url === "https://treg.to/call/treg.web.extract")).toBe(false);
    // The phone pipe still gets it.
    expect((await serve(audience.id, { reachableBy: "phone" })).body.status).toBe("served");
  });

  it("a slow site read again after 3 days is served once it answers", async () => {
    placesByQuery["Drogerie in Zürich"] = [place("ChIJ-slow", "Slow Apotheke", "044 999 00 00", "https://slow-apotheke.ch/")];
    timeoutUrls.add("https://slow-apotheke.ch/");
    const audience = await createAudience();
    expect((await serve(audience.id)).body.status).toBe("exhausted");
    await db.update(googleMapsPlaces).set({ decidedAt: new Date(Date.now() - 4 * 24 * 3600 * 1000) }).where(eq(googleMapsPlaces.placeId, "ChIJ-slow"));
    timeoutUrls.clear();
    site["https://slow-apotheke.ch/"] = { text: "Kontakt: info@slow-apotheke.ch" };
    pick = () => ({ email: "info@slow-apotheke.ch", name: null, role: null });
    const res = await serve(audience.id);
    expect(res.body.status).toBe("served");
    expect(res.body.person.email).toBe("info@slow-apotheke.ch");
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

// GMAPS-TARGET-WALK-1117: a brand's Google Maps list (role 'search') is walked by every offer audience of the brand.
describe("Google Maps list walked by an offer audience", () => {
  const OFFER_A = "00000000-0000-4000-8000-0000000000d1";
  const OFFER_B = "00000000-0000-4000-8000-0000000000d2";

  async function brandList() {
    const res = await request(app)
      .post("/orgs/audiences")
      .set(headers())
      .send({ name: "Zürich drugstores (Maps)", brandId: BRAND, provider: "google_maps", role: "search", filters: FILTERS });
    expect(res.status).toBe(201);
    expect(res.body.audience.role).toBe("search");
    return res.body.audience.id as string;
  }

  async function offerTargets() {
    const res = await request(app)
      .post("/internal/offer-audiences/realign")
      .set(getAuthHeaders())
      .send({
        reason: "gmaps-walk-test",
        orgId: ORG,
        brandId: BRAND,
        offers: [
          { offerId: OFFER_A, name: "Drugstores", text: "Independent drugstores in Zürich and their owners" },
          { offerId: OFFER_B, name: "Organic shops", text: "Organic food shops in Zürich" },
        ],
        searchAudienceIds: [],
      });
    expect(res.status).toBe(200);
    const rows = await db.select().from(audiences);
    return { a: rows.find((r) => r.offerId === OFFER_A)!.id, b: rows.find((r) => r.offerId === OFFER_B)!.id };
  }

  const next = (id: string, body: Record<string, unknown>) => request(app).post(`/orgs/audiences/${id}/candidates/next`).set(headers()).send(body);
  const reveal = (id: string, c: string) =>
    request(app).post(`/orgs/audiences/${id}/candidates/${c}/reveal`).set(headers()).send({ acceptedEmails: "valid_and_catch_all" });

  it("an offer audience serves an email lead from the brand's Google Maps list, judged on the business and the person its site names", async () => {
    placesByQuery["Drogerie in Zürich"] = [
      place("ChIJ-n", "Silent Shop", "044 555 66 77", "https://silent.ch"),
      place("ChIJ-s", "Drogerie Schwamedingerhuus", "044 322 44 46", "https://drogerieschwamendingen.com/kontakt"),
    ];
    site["https://silent.ch/"] = { text: "Nur Telefon." };
    schwamendingen();
    pick = () => ({ email: "info@drogerieschwamendingen.com", name: "Marc Pfister", role: "Geschäftsinhaber" });
    const list = await brandList();
    // A brand list is hidden from the brand's audiences.
    const listed = await request(app).get(`/orgs/audiences?brandId=${BRAND}`).set(headers());
    expect(listed.body.audiences.map((a: { id: string }) => a.id)).not.toContain(list);
    const { a } = await offerTargets();

    const n = await next(a, { reachableBy: "email" });
    expect(n.status).toBe(200);
    expect(n.body.status).toBe("candidate");
    // The shop with no published email was never offered.
    expect(n.body.candidate.providerPersonId).toBe("ChIJ-s");
    expect(n.body.candidate.person).toMatchObject({ name: "Marc Pfister", title: "Geschäftsinhaber", country: "Switzerland" });
    expect(n.body.candidate.company).toMatchObject({ name: "Drogerie Schwamedingerhuus", domain: "drogerieschwamendingen.com", industry: "Drugstore" });
    expect(n.body.target.text).toBe("Independent drugstores in Zürich and their owners");
    // Nothing verified or claimed before the reveal.
    expect(calls.some((c) => c.url === "http://apollo/email-verifications")).toBe(false);
    expect(await db.select().from(googleMapsBrandClaims)).toHaveLength(0);

    const r = await reveal(a, n.body.candidate.candidateId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "served", emailVerdict: "valid", replayed: false });
    expect(r.body.person).toMatchObject({ email: "info@drogerieschwamendingen.com", firstName: "Marc", lastName: "Pfister", phone: "+41443224446" });
    const [claim] = await db.select().from(googleMapsBrandClaims);
    expect(claim).toMatchObject({ brandId: BRAND, placeId: "ChIJ-s", audienceId: list });
    const [serveRow] = await db.select().from(leadServes);
    expect(serveRow).toMatchObject({ provider: "google_maps", email: "info@drogerieschwamendingen.com", audienceId: list });
    // A replay bills nothing.
    calls = [];
    const again = await reveal(a, n.body.candidate.candidateId);
    expect(again.body.replayed).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("one offer declining a business leaves it to the brand's other offer; once served it is taken for all", async () => {
    placesByQuery["Drogerie in Zürich"] = [place("ChIJ-s", "Drogerie Schwamedingerhuus", "044 322 44 46", "https://drogerieschwamendingen.com")];
    schwamendingen();
    pick = () => ({ email: "info@drogerieschwamendingen.com", name: null, role: null });
    await brandList();
    const { a, b } = await offerTargets();
    const na = await next(a, { reachableBy: "email" });
    await request(app).post(`/orgs/audiences/${a}/candidates/${na.body.candidate.candidateId}/decline`).set(headers()).send({ reason: "not organic" });
    const nb = await next(b, { reachableBy: "email" });
    expect(nb.body.candidate.providerPersonId).toBe("ChIJ-s");
    // The site was read once, for both offers.
    expect(calls.filter((c) => c.url === "https://treg.to/call/treg.web.extract" && c.body?.url === "https://drogerieschwamendingen.com/")).toHaveLength(1);
    expect((await reveal(b, nb.body.candidate.candidateId)).body.status).toBe("served");
    expect((await next(a, { reachableBy: "email" })).body.status).toBe("exhausted");
  });

  it("a business already claimed for the brand is never offered; a phone walk gets the phone lead as before", async () => {
    placesByQuery["Drogerie in Zürich"] = [
      place("ChIJ-s", "Drogerie Schwamedingerhuus", "044 322 44 46", "https://drogerieschwamendingen.com"),
      place("ChIJ-p", "Phone Shop", "044 555 66 79", undefined),
    ];
    await db.insert(googleMapsBrandClaims).values({ orgId: ORG, brandId: BRAND, placeId: "ChIJ-s", phoneE164: "+41443224446" });
    await brandList();
    const { a } = await offerTargets();
    const n = await next(a, { reachableBy: "phone" });
    expect(n.body.candidate.providerPersonId).toBe("ChIJ-p");
    expect(calls.some((c) => c.url === "https://treg.to/call/treg.web.extract")).toBe(false);
    const r = await reveal(a, n.body.candidate.candidateId);
    expect(r.body.status).toBe("served");
    expect(r.body.person.phone).toBe("+41445556679");
    expect(r.body.person.email).toBeNull();
    const [row] = await db.select().from(audienceCandidates);
    expect(row.serveReach).toEqual({ reachableBy: ["phone"], reachableOn: [] });
  });

  // GMAPS-LIVE-1117: the first live run offered Living Vital blank shops (dataforseo rows read as no name, no site)
  // to a cold-email campaign whose walk stated no reach, so no site was read and the judge rejected them blind.
  it("a walk stating no reach goes by email: the site is read first, and the candidate carries every fact of a dataforseo row", async () => {
    placesByQuery["Drogerie in Zürich"] = [
      {
        type: "maps_search",
        title: "Silent Shop",
        place_id: "ChIJ-n",
        phone: "+41445556677",
        url: "https://silent.ch/",
        domain: "silent.ch",
        category: "Drogerie",
        address: "Langstrasse 1, 8004 Zürich",
        address_info: { address: "Langstrasse 1", city: "Zürich", zip: "8004", country_code: "CH" },
      },
      {
        type: "maps_search",
        title: "Drogerie Schwamedingerhuus",
        place_id: "ChIJ-s",
        phone: "+41443224446",
        url: "https://drogerieschwamendingen.com/kontakt",
        domain: "drogerieschwamendingen.com",
        category: "Drogerie",
        additional_categories: ["Naturheilkundler"],
        address: "Saatlenstrasse 12, 8051 Zürich",
        address_info: { address: "Saatlenstrasse 12", city: "Zürich", zip: "8051", country_code: "CH" },
        rating: { value: 4.4, votes_count: 44 },
      },
    ];
    site["https://silent.ch/"] = { text: "Nur Telefon." };
    schwamendingen();
    pick = () => ({ email: "info@drogerieschwamendingen.com", name: "Marc Pfister", role: "Geschäftsinhaber" });
    await brandList();
    const { a } = await offerTargets();

    const n = await next(a, {});
    expect(n.body.status).toBe("candidate");
    // The site of each shop was read before any offer; the shop publishing no email never reached the judge.
    expect(calls.filter((c) => c.url === "https://treg.to/call/treg.web.extract").map((c) => c.body?.url)).toContain("https://silent.ch/");
    expect(n.body.candidate.providerPersonId).toBe("ChIJ-s");
    expect(n.body.candidate.person).toMatchObject({ name: "Marc Pfister", title: "Geschäftsinhaber", city: "Zürich", country: "Switzerland" });
    expect(n.body.candidate.company).toEqual({
      name: "Drogerie Schwamedingerhuus",
      domain: "drogerieschwamendingen.com",
      industry: "Drogerie",
      employees: null,
      city: "Zürich",
      state: null,
      country: "Switzerland",
      keywords: ["Drogerie", "Naturheilkundler"],
      address: "Saatlenstrasse 12, 8051 Zürich",
    });
    const [row] = await db.select().from(audienceCandidates);
    expect(row.serveReach).toEqual({ reachableBy: [], reachableOn: [] });
    // Its reveal serves the published address, never a phone-only lead.
    const r = await reveal(a, n.body.candidate.candidateId);
    expect(r.body.status).toBe("served");
    expect(r.body.person.email).toBe("info@drogerieschwamendingen.com");
    expect(r.body.person.organization).toMatchObject({ name: "Drogerie Schwamedingerhuus", websiteUrl: "https://drogerieschwamendingen.com/kontakt", city: "Zürich" });
  });

  it("the cheapest Maps provider answers first and treg's route is never asked; its rows read with their facts", async () => {
    cheapestByQuery["Drogerie in Zürich"] = [
      {
        title: "Drogerie Schwamedingerhuus",
        place_id: "ChIJ-s",
        type: "Drug store",
        types: ["Drug store", "Health food store"],
        address: "Saatlenstrasse 12, 8051 Zürich, Switzerland",
        phone: "+41 44 322 44 46",
        website: "https://drogerieschwamendingen.com/",
      },
    ];
    schwamendingen();
    pick = () => ({ email: "info@drogerieschwamendingen.com", name: null, role: null });
    await brandList();
    const { a } = await offerTargets();
    const n = await next(a, { reachableBy: "email" });
    expect(n.body.candidate.company).toMatchObject({ name: "Drogerie Schwamedingerhuus", domain: "drogerieschwamendingen.com", industry: "Drug store", city: "Zürich", keywords: ["Drug store", "Health food store"] });
    expect(calls.some((c) => c.url === "https://treg.to/call/treg.google.serp.maps")).toBe(false);
    const [q] = await db.select().from(googleMapsQueries);
    expect(q).toMatchObject({ servedBy: "litescrape.google.serp.maps", chargedMicro: 150, placesCount: 1 });
  });

  it("a site that times out never fails the offer walk: the next business is offered (LIVINGVITAL-SOURCING-1121)", async () => {
    placesByQuery["Drogerie in Zürich"] = [
      place("ChIJ-slow", "Slow Apotheke", "044 999 00 00", "https://slow-apotheke.ch/"),
      place("ChIJ-s", "Drogerie Schwamedingerhuus", "044 322 44 46", "https://drogerieschwamendingen.com/kontakt"),
    ];
    timeoutUrls.add("https://slow-apotheke.ch/");
    schwamendingen();
    pick = () => ({ email: "info@drogerieschwamendingen.com", name: "Marc Pfister", role: "Geschäftsinhaber" });
    await brandList();
    const { a } = await offerTargets();
    const n = await next(a, { reachableBy: "email" });
    expect(n.status).toBe(200);
    expect(n.body.status).toBe("candidate");
    expect(n.body.candidate.company.name).toBe("Drogerie Schwamedingerhuus");
    const [slow] = await db.select().from(googleMapsPlaces).where(eq(googleMapsPlaces.placeId, "ChIJ-slow"));
    expect(slow.emailStatus).toBe("site_unreadable");
  });

  it("refuses a brand list scoped to an offer", async () => {
    const res = await request(app)
      .post("/orgs/audiences")
      .set(headers())
      .send({ name: "x", brandId: BRAND, provider: "google_maps", role: "search", offerId: OFFER_A, filters: FILTERS });
    expect(res.status).toBe(400);
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
