// GOOGLE MAPS — a lead source for local merchants (GMAPS-SOURCE-1103).
//
// A brand that sells to local businesses (restaurants, shops, clinics in one
// city) finds its leads on Google Maps: those merchants carry a phone and often a
// website on their listing, rarely a person in a B2B people database. An audience
// with provider `google_maps` (list kind `google_maps_search`) holds, in its
// filters, the Google Maps searches its plain-words target expands to:
//
//   filters = { google_maps: { queries: ["restaurants in Astana", ...], country: "kz", language: "en" } }
//
// Each serve-next hands out ONE business as a lead: no person name (never
// invented), no email, its phone in E.164, its website / domain and address on
// `organization`, `providerPersonId` = the Google place id (stable: the same
// business is the same lead).
//
// THE WALK (serve-next only; candidates/next answers 422 for this provider):
//   1. take the oldest business the audience found and has not decided yet;
//   2. none left: run the audience's next search (once each, in order) through
//      treg, METERED on a child run of the serve's run (src/lib/treg-meter.ts);
//      every business it returns is stored for the audience;
//   3. no search left and nothing waiting: the source ran out, truthfully
//      (`exhausted`, reachable ceiling persisted). Never a fabricated end.
// Per business, in order: no phone ⟹ never served; the brand's own company ⟹
// never served; already served to the brand (same place OR same phone, under any
// audience) ⟹ taken; the serve writes on WhatsApp (`reachableOn: ["whatsapp"]`)
// ⟹ crm-service says whether the number is on WhatsApp (never guessed from the
// number); then ONE atomic claim per (org, brand, place) and per (org, brand,
// phone): a business is served at most once per brand, forever.
//
// A business crm-service says is NOT on WhatsApp is kept aside for that audience
// (`not_on_whatsapp`) and never claimed for the brand. When the brand itself
// cannot send on WhatsApp (no linked / connected account), nobody is consumed:
// the business goes back to waiting and the serve answers exhausted, logged.

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { db } from "../db/index.js";
import {
  audienceMembers,
  audiences,
  googleMapsBrandClaims,
  googleMapsPlaces,
  googleMapsQueries,
  leadServes,
  people,
} from "../db/schema.js";
import {
  NO_ORGANIZATION_FACTS,
  type Identity,
  type Person,
} from "./people-providers.js";
import { completeJson } from "../lib/chat-client.js";
import { crmWhatsappReach } from "../lib/crm-contacts.js";
import { TregMeter } from "../lib/treg-meter.js";
import { HOSTING_PLATFORMS, isOwnCompany, loadOwnCompany, registrableDomain } from "./own-company.js";
import { deriveBusinessLanguages } from "./business-languages.js";
import type { Reach } from "../lib/reach.js";
import type { MessagingNetwork } from "../lib/messaging-networks.js";

export const GOOGLE_MAPS_PROVIDER = "google_maps";
/** treg's routed Google Maps search (cheapest provider first, a miss tries the next). */
export const GOOGLE_MAPS_ENDPOINT = "treg.google.serp.maps";
/** The most one search may cost: $0.005, so only the cheap Maps providers answer (crawl4ai $0.00015 first). */
export const GOOGLE_MAPS_MAX_MICRO = 5_000;
/** At most this many searches per audience (each answers up to ~20 businesses). */
export const GOOGLE_MAPS_MAX_QUERIES = 40;
/** A business taken for a decision and never decided (a dead serve) is retaken after this. */
const CHECKING_LEASE_MS = 5 * 60 * 1000;

export interface GoogleMapsFilters {
  queries: string[];
  /** ISO 3166-1 alpha-2, lowercase: where the businesses are (phone numbers are read in it). */
  country: string;
  /** ISO 639-1: the language the searches are written in. */
  language: string;
}

export class GoogleMapsSourceError extends Error {
  /** 400 = the request cannot be served as stated; 502 = a producer failed. */
  constructor(
    message: string,
    readonly status: 400 | 502 = 502
  ) {
    super(message);
    this.name = "GoogleMapsSourceError";
  }
}

type AudienceRow = typeof audiences.$inferSelect;

/** The Google Maps searches of an audience, or null when it holds none (not a Google Maps list). */
export function readGoogleMapsFilters(filters: unknown): GoogleMapsFilters | null {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return null;
  const g = (filters as Record<string, unknown>).google_maps;
  if (!g || typeof g !== "object" || Array.isArray(g)) return null;
  const { queries, country, language } = g as Record<string, unknown>;
  if (!Array.isArray(queries) || queries.length === 0 || !queries.every((q) => typeof q === "string" && q.trim())) return null;
  if (typeof country !== "string" || !/^[a-z]{2}$/i.test(country)) return null;
  return {
    queries: [...new Set((queries as string[]).map((q) => q.trim()))].slice(0, GOOGLE_MAPS_MAX_QUERIES),
    country: country.toLowerCase(),
    language: typeof language === "string" && language.trim() ? language.trim().toLowerCase() : "en",
  };
}

export function isGoogleMapsAudience(row: { provider: string | null }): boolean {
  return row.provider === GOOGLE_MAPS_PROVIDER;
}

// ─── Drafting the searches from the plain-words target ─────────────────────────

const DRAFT_SYSTEM_PROMPT = [
  "You turn a description of local businesses a company wants to reach into the Google Maps searches that find them.",
  "Google Maps answers each search with about 20 places, so cover the whole target with several searches:",
  "one per kind of business the target names (and its close synonyms people use on Maps), and, for a large city, one per district or neighbourhood of that city crossed with the kind of business.",
  "Each search reads like what a person types into Google Maps: the kind of business, then the place (\"cafes in Esil district Astana\").",
  "Stay inside the target: never add a kind of business or a place the description does not cover.",
  `Write at most ${GOOGLE_MAPS_MAX_QUERIES} searches, most important first.`,
  "Also answer the ISO 3166-1 alpha-2 country code (lowercase) where these businesses are, and the ISO 639-1 language you wrote the searches in.",
].join("\n");

const DRAFT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    queries: { type: "array", items: { type: "string" } },
    country: { type: "string" },
    language: { type: "string" },
  },
  required: ["queries", "country", "language"],
};

/** The searches a plain-words target expands to (one chat-service call, org-billed with the caller's identity). */
export async function draftGoogleMapsFilters(target: string, identity: Identity): Promise<GoogleMapsFilters> {
  const out = await completeJson({
    message: `TARGET:\n${target}`,
    systemPrompt: DRAFT_SYSTEM_PROMPT,
    identity,
    responseSchema: DRAFT_RESPONSE_SCHEMA,
    provider: "anthropic",
    model: "sonnet",
    disableThinking: true,
  });
  const filters = readGoogleMapsFilters({ google_maps: out });
  if (!filters) throw new GoogleMapsSourceError(`chat-service drafted no usable Google Maps searches: ${JSON.stringify(out).slice(0, 300)}`);
  return filters;
}

// ─── The place → the neutral Person ────────────────────────────────────────────

export interface GoogleMapsPlace {
  place_id?: string;
  name?: string;
  phone?: string;
  website?: string;
  address?: string;
  category?: string;
  categories?: string[];
  latitude?: number;
  longitude?: number;
  rating?: number;
  review_count?: number;
  url?: string;
}

/** The phone in E.164, read in the audience's country; null when it is not a valid number. */
export function toE164(raw: string | null | undefined, country: string): string | null {
  if (!raw || !raw.trim()) return null;
  const parsed = parsePhoneNumberFromString(raw, country.toUpperCase() as CountryCode);
  return parsed && parsed.isValid() ? parsed.format("E.164") : null;
}

function countryName(code: string): string | null {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

/**
 * The city as Google prints it in the address ("Kenesary St 20, Astana 010000,
 * Kazakhstan" ⟹ "Astana"): the part before the country, postal code removed.
 * null when the address does not end on the country (never guessed).
 */
export function cityOfAddress(address: string | null | undefined, country: string | null): string | null {
  if (!address || !country) return null;
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts[parts.length - 1].toLowerCase() !== country.toLowerCase()) return null;
  const city = parts[parts.length - 2].replace(/\b\d[\d\s-]*\b/g, "").replace(/\s+/g, " ").trim();
  return city || null;
}

/** The business's own web domain; null for a page on a hosting platform (facebook.com, instagram.com...). */
export function businessDomain(website: string | null | undefined): string | null {
  const d = registrableDomain(website ?? null);
  return d && !HOSTING_PLATFORMS.has(d) ? d : null;
}

export function placeToPerson(place: GoogleMapsPlace, phoneE164: string, filters: GoogleMapsFilters): Person {
  const country = countryName(filters.country);
  const city = cityOfAddress(place.address, country);
  const geo = { city, state: null, country };
  return {
    firstName: null,
    lastName: null,
    name: null,
    title: null,
    headline: null,
    seniority: null,
    email: null,
    emailStatus: null,
    catchAll: null,
    inferred: null,
    linkedinUrl: null,
    photoUrl: null,
    city,
    state: null,
    country,
    timezone: null,
    businessLanguages: deriveBusinessLanguages(geo),
    provider: GOOGLE_MAPS_PROVIDER,
    providerPersonId: place.place_id ?? null,
    organization: {
      name: place.name ?? null,
      domain: businessDomain(place.website),
      websiteUrl: place.website ?? null,
      industry: place.category ?? null,
      estimatedNumEmployees: null,
      annualRevenue: null,
      linkedinUrl: null,
      logoUrl: null,
      city,
      state: null,
      country,
      ...NO_ORGANIZATION_FACTS,
      providerOrganizationId: place.place_id ?? null,
      industries: place.categories && place.categories.length > 0 ? place.categories : null,
      primaryPhone: phoneE164,
      streetAddress: place.address ?? null,
      rawAddress: place.address ?? null,
    },
    employmentHistory: null,
    buyingSignal: null,
    phone: phoneE164,
  };
}

// ─── The walk ──────────────────────────────────────────────────────────────────

export interface GoogleMapsServeResult {
  status: "served" | "exhausted" | "pending";
  person: Person | null;
  personId?: string;
}

/** Write the audience's searches as rows to run (idempotent: a search already there keeps its state). */
export async function seedGoogleMapsQueries(audience: AudienceRow, filters: GoogleMapsFilters): Promise<void> {
  await db
    .insert(googleMapsQueries)
    .values(filters.queries.map((query, position) => ({ orgId: audience.orgId, audienceId: audience.id, position, query })))
    .onConflictDoNothing();
}

// Take the oldest undecided business of the audience for a decision (a lease:
// a dead serve's business is retaken after CHECKING_LEASE_MS).
async function takePlace(audienceId: string): Promise<typeof googleMapsPlaces.$inferSelect | null> {
  const rows = await db.execute<{ id: string }>(sql`
    update google_maps_places set status = 'checking', decided_at = now()
    where id = (
      select id from google_maps_places
      where audience_id = ${audienceId}
        and (status = 'waiting' or (status = 'checking' and decided_at < now() - (${CHECKING_LEASE_MS} || ' milliseconds')::interval))
      order by found_at asc, rank asc, id asc
      limit 1
      for update skip locked
    )
    returning id`);
  const id = (rows as unknown as Array<{ id: string }>)[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(googleMapsPlaces).where(eq(googleMapsPlaces.id, id)).limit(1);
  return row ?? null;
}

async function decide(placeRowId: string, status: string): Promise<void> {
  await db.update(googleMapsPlaces).set({ status, decidedAt: new Date() }).where(eq(googleMapsPlaces.id, placeRowId));
}

async function brandAlreadyHas(orgId: string, brandId: string, placeId: string, phone: string): Promise<boolean> {
  const [row] = await db
    .select({ id: googleMapsBrandClaims.id })
    .from(googleMapsBrandClaims)
    .where(
      and(
        eq(googleMapsBrandClaims.orgId, orgId),
        eq(googleMapsBrandClaims.brandId, brandId),
        or(eq(googleMapsBrandClaims.placeId, placeId), eq(googleMapsBrandClaims.phoneE164, phone))
      )
    )
    .limit(1);
  return !!row;
}

// Run the audience's next search, once. Returns false when every search already ran.
async function runNextQuery(audience: AudienceRow, filters: GoogleMapsFilters, meter: TregMeter): Promise<boolean> {
  const [query] = await db
    .select()
    .from(googleMapsQueries)
    .where(and(eq(googleMapsQueries.audienceId, audience.id), isNull(googleMapsQueries.ranAt)))
    .orderBy(asc(googleMapsQueries.position))
    .limit(1);
  if (!query) return false;

  const answer = await meter.call(GOOGLE_MAPS_ENDPOINT, {
    method: "POST",
    body: { q: query.query, country: filters.country, language: filters.language },
    maxMicro: GOOGLE_MAPS_MAX_MICRO,
  });
  const runId = await meter.openedRunId();
  if (answer.status < 200 || answer.status >= 300) {
    // A routed miss (no provider found anything / all failed): recorded with its
    // charge, NOT marked ran, so a later serve asks again. Loud, never a silent empty.
    await db.update(googleMapsQueries).set({ runId, chargedMicro: answer.chargedMicro, error: `${answer.status}: ${JSON.stringify(answer.body).slice(0, 500)}` }).where(eq(googleMapsQueries.id, query.id));
    throw new GoogleMapsSourceError(`treg ${GOOGLE_MAPS_ENDPOINT} answered ${answer.status} for "${query.query}": ${JSON.stringify(answer.body).slice(0, 300)}`);
  }
  const output = (answer.body?.output ?? null) as { places?: unknown } | null;
  if (!output || !Array.isArray(output.places)) {
    throw new GoogleMapsSourceError(`treg ${GOOGLE_MAPS_ENDPOINT} answered no output.places for "${query.query}"`);
  }
  const places = (output.places as GoogleMapsPlace[]).filter((p) => typeof p?.place_id === "string" && p.place_id);
  let inserted = 0;
  if (places.length > 0) {
    const rows = await db
      .insert(googleMapsPlaces)
      .values(
        places.map((p, rank) => ({
          orgId: audience.orgId,
          audienceId: audience.id,
          placeId: p.place_id!,
          queryId: query.id,
          rank,
          place: p as Record<string, unknown>,
          phoneE164: toE164(p.phone, filters.country),
          foundRunId: runId,
        }))
      )
      .onConflictDoNothing()
      .returning({ id: googleMapsPlaces.id });
    inserted = rows.length;
  }
  await db
    .update(googleMapsQueries)
    .set({ ranAt: new Date(), runId, servedBy: answer.servedBy, chargedMicro: answer.chargedMicro, placesCount: places.length, newPlacesCount: inserted, error: null })
    .where(eq(googleMapsQueries.id, query.id));
  console.log(
    `[human-service] google_maps.search org=${audience.orgId} audience=${audience.id} query=${JSON.stringify(query.query)} places=${places.length} new=${inserted} charged_micro=${answer.chargedMicro} served_by=${answer.servedBy ?? "-"} run=${runId ?? "-"}`
  );
  return true;
}

// The one per-brand claim, then the person, membership and bronze serve, in one transaction.
async function claimAndServe(
  audience: AudienceRow,
  identity: Identity,
  row: typeof googleMapsPlaces.$inferSelect,
  person: Person
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const phone = row.phoneE164!;
    const claimed = await tx
      .insert(googleMapsBrandClaims)
      .values({ orgId: audience.orgId, brandId: audience.brandId, placeId: row.placeId, phoneE164: phone, audienceId: audience.id, runId: identity.runId ?? null })
      .onConflictDoNothing()
      .returning({ id: googleMapsBrandClaims.id });
    if (claimed.length === 0) return null;

    // One person per business per org: another brand of the org may have served it already.
    const [known] = await tx
      .select({ personId: googleMapsBrandClaims.personId })
      .from(googleMapsBrandClaims)
      .where(and(eq(googleMapsBrandClaims.orgId, audience.orgId), eq(googleMapsBrandClaims.placeId, row.placeId), sql`${googleMapsBrandClaims.personId} is not null`))
      .limit(1);
    let personId = known?.personId ?? null;
    if (!personId) {
      const [created] = await tx
        .insert(people)
        .values({
          orgId: audience.orgId,
          companyName: person.organization?.name ?? null,
          companyDomain: person.organization?.domain ?? null,
        })
        .returning({ id: people.id });
      personId = created.id;
    }
    await tx.update(googleMapsBrandClaims).set({ personId }).where(eq(googleMapsBrandClaims.id, claimed[0].id));
    await tx
      .insert(audienceMembers)
      .values({ orgId: audience.orgId, audienceId: audience.id, personId, source: GOOGLE_MAPS_PROVIDER, confidence: "provider_confirmed", provenance: "served" })
      .onConflictDoUpdate({
        target: [audienceMembers.audienceId, audienceMembers.personId],
        set: { lastServedAt: sql`now()`, source: GOOGLE_MAPS_PROVIDER, provenance: "served" },
      });
    await tx.insert(leadServes).values({
      orgId: audience.orgId,
      brandId: audience.brandId,
      provider: GOOGLE_MAPS_PROVIDER,
      providerPersonId: row.placeId,
      companyDomain: person.organization?.domain ?? null,
      campaignId: identity.campaignId ?? null,
      runId: identity.runId ?? null,
      audienceId: audience.id,
    });
    await tx
      .update(googleMapsPlaces)
      .set({ status: "served", decidedAt: new Date(), personId, servedRunId: identity.runId ?? null })
      .where(eq(googleMapsPlaces.id, row.id));
    return personId;
  });
}

export async function serveNextGoogleMaps(
  audience: AudienceRow,
  identity: Identity,
  reach: readonly Reach[],
  reachableOn: readonly MessagingNetwork[],
  deadline: number
): Promise<GoogleMapsServeResult> {
  const filters = readGoogleMapsFilters(audience.filters);
  if (!filters) throw new GoogleMapsSourceError(`audience ${audience.id} holds no Google Maps searches`);
  // A business carries a phone, never an email.
  if (reach.includes("email")) {
    console.log(`[human-service] reach.provider_cannot_reach org=${identity.orgId} audience=${audience.id} provider=google_maps reach=${reach.join(",")}`);
    return { status: "exhausted", person: null };
  }
  const onWhatsapp = reachableOn.includes("whatsapp");
  const unsupported = reachableOn.filter((n) => n !== "whatsapp");
  if (unsupported.length > 0) {
    // No owner answers "is this number on <network>" for these yet: never served on a guess.
    console.log(`[human-service] google_maps.network_not_checkable org=${identity.orgId} audience=${audience.id} reachableOn=${unsupported.join(",")}`);
    return { status: "exhausted", person: null };
  }

  await seedGoogleMapsQueries(audience, filters);
  const own = await loadOwnCompany(identity.orgId, [audience.brandId]);
  let meter: TregMeter | null = null;
  let failed = false;
  try {
    while (Date.now() < deadline) {
      const row = await takePlace(audience.id);
      if (!row) {
        if (!identity.runId || !identity.userId) {
          throw new GoogleMapsSourceError("a Google Maps search is paid: serve-next needs x-run-id and x-user-id", 400);
        }
        meter ??= new TregMeter(
          { orgId: identity.orgId, userId: identity.userId, runId: identity.runId, brandIds: [audience.brandId], campaignId: identity.campaignId, workflowTracking: identity.workflowTracking },
          "google-maps-search",
          `/orgs/audiences/${audience.id}/serve-next`
        );
        if (await runNextQuery(audience, filters, meter)) continue;
        await persistGoogleMapsReachable(audience);
        console.log(`[human-service] google_maps.exhausted org=${identity.orgId} audience=${audience.id} queries=${filters.queries.length}`);
        return { status: "exhausted", person: null };
      }

      const place = row.place as GoogleMapsPlace;
      if (!row.phoneE164) {
        await decide(row.id, "no_phone");
        continue;
      }
      if (isOwnCompany(own, { name: place.name ?? null, website: place.website ?? null })) {
        await decide(row.id, "own_company");
        continue;
      }
      if (await brandAlreadyHas(audience.orgId, audience.brandId, row.placeId, row.phoneE164)) {
        await decide(row.id, "taken");
        continue;
      }
      if (onWhatsapp) {
        const wa = await crmWhatsappReach(audience.brandId, row.phoneE164, identity).catch(async (err) => {
          await decide(row.id, "waiting");
          throw err;
        });
        if (!wa.reachable) {
          if (wa.code === "not_on_whatsapp") {
            await decide(row.id, "not_on_whatsapp");
            continue;
          }
          // The BRAND cannot send on WhatsApp now: nobody is consumed.
          await decide(row.id, "waiting");
          console.warn(`[human-service] google_maps.whatsapp_unavailable org=${identity.orgId} audience=${audience.id} brand=${audience.brandId} code=${wa.code}: ${wa.error}`);
          return { status: "exhausted", person: null };
        }
      }
      const person = placeToPerson(place, row.phoneE164, filters);
      const personId = await claimAndServe(audience, identity, row, person);
      if (!personId) {
        await decide(row.id, "taken");
        continue;
      }
      console.log(`[human-service] google_maps.served org=${identity.orgId} audience=${audience.id} place=${row.placeId} run=${identity.runId ?? "-"}`);
      return { status: "served", person, personId };
    }
    return { status: "pending", person: null };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (meter) await meter.close(failed ? "failed" : "completed");
  }
}

// Exhaustion: the reachable ceiling = the businesses this audience served.
async function persistGoogleMapsReachable(audience: AudienceRow): Promise<void> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${audienceMembers.personId})` })
    .from(audienceMembers)
    .where(eq(audienceMembers.audienceId, audience.id));
  await db.update(audiences).set({ reachableCount: Number(row?.n ?? 0), updatedAt: new Date() }).where(eq(audiences.id, audience.id));
}

/** still-fits for a phone-only find: the business this audience served at that phone (no paid call). */
export async function googleMapsStillFits(audienceId: string, orgId: string, brandId: string, phone: string): Promise<boolean> {
  const [row] = await db
    .select({ id: googleMapsBrandClaims.id })
    .from(googleMapsBrandClaims)
    .where(
      and(
        eq(googleMapsBrandClaims.orgId, orgId),
        eq(googleMapsBrandClaims.brandId, brandId),
        eq(googleMapsBrandClaims.audienceId, audienceId),
        eq(googleMapsBrandClaims.phoneE164, phone)
      )
    )
    .limit(1);
  return !!row;
}
