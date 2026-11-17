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
// Each serve-next hands out ONE business as a lead: its phone in E.164, its
// website / domain and address on `organization`, `providerPersonId` = the
// Google place id (stable: the same business is the same lead). A phone serve
// carries no email and no person name (never invented).
//
// EMAIL REACH (GMAPS-EMAIL-1117): a serve asking `reachableBy: email` reads the
// business's own website (google-maps-site-contact.ts: homepage + the contact /
// legal pages it links to, through treg, metered, stored once per place) and
// serves the address the site PUBLISHES, with the person the site names when it
// names one; the address is verified by apollo-service (POST /email-verifications,
// the fleet's verifier) and served only when valid or catch-all (plus unknown when
// the caller states `valid_catch_all_and_unknown`). Never a guessed address. The
// email also passes the fleet's email gates (brand suppression, opt-out, won,
// bounce) and is claimed in brand_suppressions beside the business claim.
// A business lacking the channel a serve needs (no phone for a phone serve, no
// published / deliverable email for an email serve) is NOT decided for good: it
// stays waiting, filtered out of that channel's walk, so the other channel's
// pipe still gets it.
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
// (`not_on_whatsapp`) and never claimed for the brand; same for a number the
// brand's user stated is not someone of the brand (`stated_not_to_brand`, a
// people correction crm-service owns): that one business is skipped, sourcing
// goes on. When the brand itself
// cannot send on WhatsApp (no linked / connected account), nobody is consumed:
// the business goes back to waiting and the serve answers exhausted, logged.

import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { db } from "../db/index.js";
import {
  audienceCandidates,
  audienceMembers,
  audiences,
  type AudienceCandidate,
  type TeaserSnapshot,
  brandSuppressions,
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
import { apolloPost } from "./people-providers.js";
import { isVerdictAccepted, type AcceptedEmails, type EmailVerdict } from "../lib/email-verification.js";
import { isEmailSuppressed, normalizeEmail } from "./suppression.js";
import { isEmailWonForRequest, isPersonOptedOut } from "./opt-outs.js";
import { isEmailBounced } from "./bounces.js";
import { siteContactOf, type SiteContact } from "./google-maps-site-contact.js";

export const GOOGLE_MAPS_PROVIDER = "google_maps";
/**
 * treg's routed Google Maps search (cheapest provider first, a miss tries the next). Sent the search text ONLY:
 * a `country` / `language` filter makes treg skip every provider that ignores filters (crawl4ai), so the whole
 * Living Vital run went to dataforseo at $0.002 a search (GMAPS-LIVE-1117). The place is in the search text.
 */
export const GOOGLE_MAPS_ENDPOINT = "treg.google.serp.maps";
/** The most one routed search may cost: $0.005, so only the cheap Maps providers answer (crawl4ai $0.00023 first). */
export const GOOGLE_MAPS_MAX_MICRO = 5_000;
/** The cheapest Maps search treg sells ($0.00015 a hit, failures free) but does not route to: asked first. */
export const GOOGLE_MAPS_CHEAPEST_ENDPOINT = "litescrape.google.serp.maps";
export const GOOGLE_MAPS_CHEAPEST_MAX_MICRO = 1_000;
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

/** A business as we read it, whatever provider found it (`readPlace`). */
export interface GoogleMapsPlace {
  place_id?: string;
  name?: string;
  phone?: string;
  website?: string;
  address?: string;
  /** The city the provider states (dataforseo's address_info); else read from the address. */
  city?: string;
  category?: string;
  categories?: string[];
  latitude?: number;
  longitude?: number;
  rating?: number;
  review_count?: number;
  url?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((x): x is string => !!x) : []);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * One business row as stored (bronze: the provider's own row, verbatim) read into our shape. The Maps providers
 * name the same facts differently: crawl4ai `name` / `website` / `categories`; dataforseo `title` / `url` (the
 * site) / `category` + `additional_categories` / `address_info`; litescrape `title` / `website` / `type` + `types`.
 * Before this, a dataforseo row read as a business with no name and no website (GMAPS-LIVE-1117).
 */
export function readPlace(raw: unknown): GoogleMapsPlace {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const info = (r.address_info && typeof r.address_info === "object" ? r.address_info : null) as Record<string, unknown> | null;
  // dataforseo's `type` is the row kind ("maps_search"), litescrape's the business category.
  const dataforseo = r.type === "maps_search" || info !== null;
  const domain = str(r.domain);
  const website = str(r.website) ?? (dataforseo ? str(r.url) : undefined) ?? (domain ? `https://${domain}` : undefined);
  const category = str(r.category) ?? (dataforseo ? undefined : str(r.type));
  const categories = [...new Set([...(category ? [category] : []), ...strs(r.categories), ...strs(r.types), ...strs(r.additional_categories)])];
  let address = str(r.address);
  const city = info ? str(info.city) : undefined;
  if (info) {
    const street = str(info.address) ?? address;
    const place = [str(info.zip), city].filter(Boolean).join(" ");
    address = [street, place].filter(Boolean).join(", ") || address;
  }
  const rating = r.rating && typeof r.rating === "object" ? (r.rating as Record<string, unknown>) : null;
  return {
    place_id: str(r.place_id),
    name: str(r.name) ?? str(r.title),
    phone: str(r.phone),
    website,
    address,
    city,
    category,
    categories: categories.length > 0 ? categories : undefined,
    latitude: num(r.latitude) ?? num((r.gps_coordinates as Record<string, unknown> | undefined)?.latitude),
    longitude: num(r.longitude) ?? num((r.gps_coordinates as Record<string, unknown> | undefined)?.longitude),
    rating: num(r.rating) ?? (rating ? num(rating.value) : undefined),
    review_count: num(r.review_count) ?? num(r.reviews) ?? (rating ? num(rating.votes_count) : undefined),
    url: dataforseo ? undefined : str(r.url),
  };
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

/** The person the site names, split as written ("Marc Pfister" ⟹ Marc / Pfister). */
export function splitContactName(name: string | null): { firstName: string | null; lastName: string | null } {
  if (!name) return { firstName: null, lastName: null };
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

export interface PlaceEmail {
  email: string;
  verdict: EmailVerdict;
  contactName: string | null;
  contactRole: string | null;
}

export function placeToPerson(place: GoogleMapsPlace, phoneE164: string | null, filters: GoogleMapsFilters, contact: PlaceEmail | null = null): Person {
  const country = countryName(filters.country);
  const city = place.city ?? cityOfAddress(place.address, country);
  const geo = { city, state: null, country };
  const named = splitContactName(contact?.contactName ?? null);
  return {
    firstName: named.firstName,
    lastName: named.lastName,
    name: contact?.contactName ?? null,
    title: contact?.contactRole ?? null,
    headline: null,
    seniority: null,
    email: contact?.email ?? null,
    emailStatus: contact?.verdict ?? null,
    catchAll: contact ? contact.verdict === "catch_all" : null,
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
    ...(phoneE164 ? { phone: phoneE164 } : {}),
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
async function takePlace(audienceId: string, fits: SQL): Promise<typeof googleMapsPlaces.$inferSelect | null> {
  const rows = await db.execute<{ id: string }>(sql`
    update google_maps_places set status = 'checking', decided_at = now()
    where id = (
      select id from google_maps_places
      where audience_id = ${audienceId}
        and (status = 'waiting' or (status = 'checking' and decided_at < now() - (${CHECKING_LEASE_MS} || ' milliseconds')::interval))
        and ${fits}
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

async function brandAlreadyHas(orgId: string, brandId: string, placeId: string, phone: string | null): Promise<boolean> {
  const [row] = await db
    .select({ id: googleMapsBrandClaims.id })
    .from(googleMapsBrandClaims)
    .where(
      and(
        eq(googleMapsBrandClaims.orgId, orgId),
        eq(googleMapsBrandClaims.brandId, brandId),
        phone ? or(eq(googleMapsBrandClaims.placeId, placeId), eq(googleMapsBrandClaims.phoneE164, phone)) : eq(googleMapsBrandClaims.placeId, placeId)
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

  // The cheapest provider first (failures are free); its miss, or an answer without places, goes to treg's route.
  const cheap = await meter.call(`${GOOGLE_MAPS_CHEAPEST_ENDPOINT}?${new URLSearchParams({ q: query.query, type: "search" })}`, {
    method: "GET",
    maxMicro: GOOGLE_MAPS_CHEAPEST_MAX_MICRO,
  });
  const cheapPlaces = cheap.status >= 200 && cheap.status < 300 && Array.isArray(cheap.body?.local_results) ? (cheap.body!.local_results as unknown[]) : null;
  if (!cheapPlaces || cheapPlaces.length === 0) {
    console.log(
      `[human-service] google_maps.cheapest_missed audience=${audience.id} query=${JSON.stringify(query.query)} status=${cheap.status} places=${cheapPlaces?.length ?? "-"}`
    );
  }
  const answer =
    cheapPlaces && cheapPlaces.length > 0
      ? { ...cheap, servedBy: cheap.servedBy ?? GOOGLE_MAPS_CHEAPEST_ENDPOINT, body: { output: { places: cheapPlaces } } as Record<string, unknown> }
      : await meter.call(GOOGLE_MAPS_ENDPOINT, { method: "POST", body: { q: query.query }, maxMicro: GOOGLE_MAPS_MAX_MICRO });
  const charged = (cheapPlaces && cheapPlaces.length > 0 ? 0 : cheap.chargedMicro) + answer.chargedMicro;
  const runId = await meter.openedRunId();
  if (answer.status < 200 || answer.status >= 300) {
    // A routed miss (no provider found anything / all failed): recorded with its
    // charge, NOT marked ran, so a later serve asks again. Loud, never a silent empty.
    await db.update(googleMapsQueries).set({ runId, chargedMicro: charged, error: `${answer.status}: ${JSON.stringify(answer.body).slice(0, 500)}` }).where(eq(googleMapsQueries.id, query.id));
    throw new GoogleMapsSourceError(`treg ${GOOGLE_MAPS_ENDPOINT} answered ${answer.status} for "${query.query}": ${JSON.stringify(answer.body).slice(0, 300)}`);
  }
  const output = (answer.body?.output ?? null) as { places?: unknown } | null;
  if (!output || !Array.isArray(output.places)) {
    throw new GoogleMapsSourceError(`treg ${GOOGLE_MAPS_ENDPOINT} answered no output.places for "${query.query}"`);
  }
  const places = (output.places as unknown[]).filter((p) => !!readPlace(p).place_id);
  let inserted = 0;
  if (places.length > 0) {
    const rows = await db
      .insert(googleMapsPlaces)
      .values(
        places.map((p, rank) => ({
          orgId: audience.orgId,
          audienceId: audience.id,
          placeId: readPlace(p).place_id!,
          queryId: query.id,
          rank,
          place: p as Record<string, unknown>,
          phoneE164: toE164(readPlace(p).phone, filters.country),
          foundRunId: runId,
        }))
      )
      .onConflictDoNothing()
      .returning({ id: googleMapsPlaces.id });
    inserted = rows.length;
  }
  await db
    .update(googleMapsQueries)
    .set({ ranAt: new Date(), runId, servedBy: answer.servedBy, chargedMicro: charged, placesCount: places.length, newPlacesCount: inserted, error: null })
    .where(eq(googleMapsQueries.id, query.id));
  console.log(
    `[human-service] google_maps.search org=${audience.orgId} audience=${audience.id} query=${JSON.stringify(query.query)} places=${places.length} new=${inserted} charged_micro=${charged} served_by=${answer.servedBy ?? "-"} run=${runId ?? "-"}`
  );
  return true;
}

// The one per-brand claim, then the person, membership and bronze serve, in one transaction.
async function claimAndServe(
  audience: AudienceRow,
  identity: Identity,
  row: typeof googleMapsPlaces.$inferSelect,
  person: Person,
  emailVerdict: EmailVerdict | null = null
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const phone = row.phoneE164;
    const emailNorm = normalizeEmail(person.email);
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
    if (!personId && emailNorm) {
      // The org may already hold this address (another source found it): one person.
      const [holder] = await tx.select({ id: people.id }).from(people).where(and(eq(people.orgId, audience.orgId), eq(people.emailNorm, emailNorm))).limit(1);
      personId = holder?.id ?? null;
    }
    if (!personId) {
      const [created] = await tx
        .insert(people)
        .values({
          orgId: audience.orgId,
          emailNorm,
          firstName: person.firstName,
          lastName: person.lastName,
          fullName: person.name,
          title: person.title,
          companyName: person.organization?.name ?? null,
          companyDomain: person.organization?.domain ?? null,
        })
        .returning({ id: people.id });
      personId = created.id;
    } else if (emailNorm) {
      // The business's person learns its published address (when nobody else in the org holds it).
      await tx.execute(sql`
        update people set email_norm = ${emailNorm},
          first_name = coalesce(first_name, ${person.firstName}), last_name = coalesce(last_name, ${person.lastName}),
          full_name = coalesce(full_name, ${person.name}), title = coalesce(title, ${person.title})
        where id = ${personId} and email_norm is null
          and not exists (select 1 from people p2 where p2.org_id = ${audience.orgId} and p2.email_norm = ${emailNorm})`);
    }
    if (emailNorm) {
      // The brand now holds this address: no other source re-serves it inside the window.
      await tx
        .insert(brandSuppressions)
        .values({ orgId: audience.orgId, brandId: audience.brandId, emailNorm, providerPersonId: row.placeId, lastProvider: GOOGLE_MAPS_PROVIDER })
        .onConflictDoUpdate({
          target: [brandSuppressions.orgId, brandSuppressions.brandId, brandSuppressions.emailNorm],
          set: { lastServedAt: sql`now()`, lastProvider: GOOGLE_MAPS_PROVIDER },
        });
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
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      emailVerdict,
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

/** The verdicts an email serve hands out: valid + catch-all always, unknown when the caller asks for it. */
export function googleMapsAcceptedVerdicts(accepted: AcceptedEmails | undefined): EmailVerdict[] {
  return accepted === "valid_catch_all_and_unknown" ? ["valid", "catch_all", "unknown"] : ["valid", "catch_all"];
}

/** apollo-service's verdict on an address we hold (its verifier, its cost, on the serve's run). */
async function verifyEmail(email: string, identity: Identity): Promise<EmailVerdict> {
  const body = (await apolloPost("/email-verifications", { emails: [email], source: "google-maps" }, identity)) as {
    results?: Array<{ email?: unknown; verdict?: unknown; deliverable?: unknown }>;
  };
  const r = body.results?.[0];
  if (!r || typeof r.verdict !== "string" || typeof r.deliverable !== "boolean" || !["valid", "invalid", "catch_all", "risky", "unknown"].includes(r.verdict)) {
    throw new GoogleMapsSourceError(`apollo-service verified ${email} without a usable verdict: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return r.verdict as EmailVerdict;
}

async function setEmailState(rowId: string, state: { emailStatus: string; email?: string | null; emailVerdict?: string | null }): Promise<void> {
  await db
    .update(googleMapsPlaces)
    .set({ status: "waiting", decidedAt: new Date(), emailStatus: state.emailStatus, ...(state.email !== undefined ? { email: state.email } : {}), ...(state.emailVerdict !== undefined ? { emailVerdict: state.emailVerdict } : {}) })
    .where(eq(googleMapsPlaces.id, rowId));
}

// The channels one serve needs, and the SQL that keeps a business that cannot carry them out of its walk.
interface ServeChannels {
  needEmail: boolean;
  needPhone: boolean;
  onWhatsapp: boolean;
  accepted: EmailVerdict[];
  fits: SQL;
}

/** null = the serve writes on a network nobody can check a number for: never served on a guess. */
function serveChannels(reach: readonly Reach[], reachableOn: readonly MessagingNetwork[], acceptedEmails: AcceptedEmails | undefined): ServeChannels | null {
  if (reachableOn.some((n) => n !== "whatsapp")) return null;
  const onWhatsapp = reachableOn.includes("whatsapp");
  // A phone / WhatsApp pipe needs the phone; an email pipe, and a serve stating NO reach, the published address:
  // `served` carries a usable email unless the pipe says otherwise (the serve-next contract every provider keeps).
  // Before GMAPS-LIVE-1117 no reach meant phone: a cold-email campaign got 265 shops without an address.
  const needPhone = reach.includes("phone") || onWhatsapp;
  const needEmail = reach.includes("email") || !needPhone;
  const accepted = googleMapsAcceptedVerdicts(acceptedEmails);
  const fits = and(
    needPhone ? sql`phone_e164 is not null` : sql`true`,
    needEmail
      ? sql`(email_status is null or (email_status = 'found' and (email_verdict is null or email_verdict in (${sql.join(accepted.map((v) => sql`${v}`), sql`, `)}))))`
      : sql`true`
  )!;
  return { needEmail, needPhone, onWhatsapp, accepted, fits };
}

// The metered treg clients of one call (each opens its child run on first use), closed together.
class GoogleMapsMeters {
  private maps: TregMeter | null = null;
  private site: TregMeter | null = null;
  constructor(
    private readonly identity: Identity,
    private readonly brandId: string,
    private readonly callerPath: string
  ) {}
  private meterIdentity() {
    const { identity } = this;
    if (!identity.runId || !identity.userId) {
      throw new GoogleMapsSourceError("a Google Maps search or site read is paid: the serve needs x-run-id and x-user-id", 400);
    }
    return { orgId: identity.orgId, userId: identity.userId, runId: identity.runId, brandIds: [this.brandId], campaignId: identity.campaignId, workflowTracking: identity.workflowTracking };
  }
  search(): TregMeter {
    return (this.maps ??= new TregMeter(this.meterIdentity(), "google-maps-search", this.callerPath));
  }
  siteRead(): TregMeter {
    return (this.site ??= new TregMeter(this.meterIdentity(), "google-maps-site-read", this.callerPath));
  }
  async close(failed: boolean): Promise<void> {
    if (this.maps) await this.maps.close(failed ? "failed" : "completed");
    if (this.site) await this.site.close(failed ? "failed" : "completed");
  }
}

/** Why a business was not served (it stays for another channel when the reason is about this channel only). */
export type GoogleMapsSkipReason =
  | "own_company"
  | "taken"
  | "no_phone"
  | "no_website"
  | "no_email"
  | "not_deliverable"
  | "opted_out"
  | "won"
  | "bounced"
  | "not_on_whatsapp"
  | "stated_not_to_brand";

type PlaceOutcome =
  | { kind: "served"; person: Person; personId: string; verdict: EmailVerdict | null }
  | { kind: "skipped"; reason: GoogleMapsSkipReason; verdict?: EmailVerdict }
  | { kind: "brand_cannot_send"; code: string };

type PlaceRow = typeof googleMapsPlaces.$inferSelect;

// Read the business's own site once (stored per place): the published email and the person it names, onto the row.
// Returns the read, or the channel reason the business cannot be written to by email.
async function readSiteOf(row: PlaceRow, identity: Identity, meters: GoogleMapsMeters): Promise<SiteContact | GoogleMapsSkipReason> {
  const place = readPlace(row.place);
  const site = await siteContactOf({
    placeId: row.placeId,
    businessName: place.name ?? null,
    website: place.website ?? null,
    identity,
    meter: () => meters.siteRead(),
  }).catch(async (err) => {
    await decide(row.id, "waiting");
    throw err;
  });
  if (site.outcome !== "found" || !site.email) {
    await setEmailState(row.id, { emailStatus: site.outcome, email: null });
    return site.outcome === "no_website" ? "no_website" : "no_email";
  }
  await db.update(googleMapsPlaces).set({ emailStatus: "found", email: site.email }).where(eq(googleMapsPlaces.id, row.id));
  row.emailStatus = "found";
  row.email = site.email;
  return site;
}

/**
 * Decide ONE business of a Google Maps list for a serve, and serve it when it passes: the same rules for serve-next and
 * for an offer audience's reveal. `search` is the Google Maps list (the claim, the serve and the membership are its).
 */
async function servePlace(
  search: AudienceRow,
  row: PlaceRow,
  identity: Identity,
  filters: GoogleMapsFilters,
  own: Awaited<ReturnType<typeof loadOwnCompany>>,
  ch: ServeChannels,
  meters: GoogleMapsMeters
): Promise<PlaceOutcome> {
  const place = readPlace(row.place);
  if (isOwnCompany(own, { name: place.name ?? null, website: place.website ?? null })) {
    await decide(row.id, "own_company");
    return { kind: "skipped", reason: "own_company" };
  }
  if (await brandAlreadyHas(search.orgId, search.brandId, row.placeId, row.phoneE164)) {
    await decide(row.id, "taken");
    return { kind: "skipped", reason: "taken" };
  }
  if (ch.needPhone && !row.phoneE164) {
    await decide(row.id, "waiting");
    return { kind: "skipped", reason: "no_phone" };
  }

  let contact: PlaceEmail | null = null;
  if (ch.needEmail) {
    let site: SiteContact | null = null;
    if (row.emailStatus === null) {
      const read = await readSiteOf(row, identity, meters);
      if (typeof read === "string") return { kind: "skipped", reason: read };
      site = read;
    }
    const email = row.emailStatus === "found" ? row.email : null;
    if (!email) {
      await decide(row.id, "waiting");
      return { kind: "skipped", reason: row.emailStatus === "no_website" ? "no_website" : row.emailStatus === "not_deliverable" ? "not_deliverable" : "no_email" };
    }
    // The fleet's email facts about this address, before paying to verify it.
    const brandIdentity = { ...identity, brandIds: [search.brandId] };
    if (await isEmailSuppressed(search.orgId, [search.brandId], email, identity.excludeEmailedWithin)) {
      await decide(row.id, "taken");
      return { kind: "skipped", reason: "taken" };
    }
    if (await isPersonOptedOut(brandIdentity, email)) {
      await decide(row.id, "opted_out");
      return { kind: "skipped", reason: "opted_out" };
    }
    if (await isEmailWonForRequest(brandIdentity, email)) {
      await decide(row.id, "won");
      return { kind: "skipped", reason: "won" };
    }
    if (await isEmailBounced(brandIdentity, email)) {
      await setEmailState(row.id, { emailStatus: "not_deliverable", email, emailVerdict: "invalid" });
      return { kind: "skipped", reason: "bounced" };
    }
    const verdict =
      (row.emailVerdict as EmailVerdict | null) ??
      (await verifyEmail(email, identity).catch(async (err) => {
        await decide(row.id, "waiting");
        throw err;
      }));
    if (!ch.accepted.includes(verdict)) {
      await setEmailState(row.id, { emailStatus: verdict === "invalid" || verdict === "risky" ? "not_deliverable" : "found", email, emailVerdict: verdict });
      return { kind: "skipped", reason: "not_deliverable", verdict };
    }
    await db.update(googleMapsPlaces).set({ emailStatus: "found", email, emailVerdict: verdict }).where(eq(googleMapsPlaces.id, row.id));
    // Same read as the stored row when the site was read on an earlier call.
    const named =
      site ??
      (await siteContactOf({ placeId: row.placeId, businessName: null, website: null, identity, meter: () => { throw new GoogleMapsSourceError(`site of ${row.placeId} not stored`); } }));
    contact = { email, verdict, contactName: named.contactName, contactRole: named.contactRole };
  }

  if (ch.onWhatsapp && row.phoneE164) {
    const wa = await crmWhatsappReach(search.brandId, row.phoneE164, identity).catch(async (err) => {
      await decide(row.id, "waiting");
      throw err;
    });
    if (!wa.reachable) {
      if (wa.code === "not_on_whatsapp" || wa.code === "stated_not_to_brand") {
        await decide(row.id, wa.code);
        return { kind: "skipped", reason: wa.code };
      }
      // The BRAND cannot send on WhatsApp now: nobody is consumed.
      await decide(row.id, "waiting");
      console.warn(`[human-service] google_maps.whatsapp_unavailable org=${identity.orgId} audience=${search.id} brand=${search.brandId} code=${wa.code}: ${wa.error}`);
      return { kind: "brand_cannot_send", code: wa.code };
    }
  }
  const person = placeToPerson(place, row.phoneE164, filters, contact);
  const personId = await claimAndServe(search, identity, row, person, contact?.verdict ?? null);
  if (!personId) {
    await decide(row.id, "taken");
    return { kind: "skipped", reason: "taken" };
  }
  console.log(
    `[human-service] google_maps.served org=${identity.orgId} audience=${search.id} place=${row.placeId} email=${contact ? contact.verdict : "-"} named=${contact?.contactName ? "yes" : "no"} run=${identity.runId ?? "-"}`
  );
  return { kind: "served", person, personId, verdict: contact?.verdict ?? null };
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
  const ch = serveChannels(reach, reachableOn, identity.acceptedEmails);
  if (!ch) {
    console.log(`[human-service] google_maps.network_not_checkable org=${identity.orgId} audience=${audience.id} reachableOn=${reachableOn.join(",")}`);
    return { status: "exhausted", person: null };
  }

  await seedGoogleMapsQueries(audience, filters);
  const own = await loadOwnCompany(identity.orgId, [audience.brandId]);
  const meters = new GoogleMapsMeters(identity, audience.brandId, `/orgs/audiences/${audience.id}/serve-next`);
  let failed = false;
  try {
    while (Date.now() < deadline) {
      const row = await takePlace(audience.id, ch.fits);
      if (!row) {
        if (await runNextQuery(audience, filters, meters.search())) continue;
        await persistGoogleMapsReachable(audience);
        console.log(`[human-service] google_maps.exhausted org=${identity.orgId} audience=${audience.id} queries=${filters.queries.length} reach=${reach.join(",") || "-"}`);
        return { status: "exhausted", person: null };
      }
      const out = await servePlace(audience, row, identity, filters, own, ch, meters);
      if (out.kind === "served") return { status: "served", person: out.person, personId: out.personId };
      if (out.kind === "brand_cannot_send") return { status: "exhausted", person: null };
    }
    return { status: "pending", person: null };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await meters.close(failed);
  }
}

// ─── An offer audience walks the brand's Google Maps list (GMAPS-TARGET-WALK-1117) ─────────────────────────────────
//
// ONE AUDIENCE PER OFFER (offer-audiences.ts): a brand's Google Maps list (role 'search') is walked by every offer
// audience (role 'target') of the brand. Each business is offered as a CANDIDATE of the target (free), judged by the
// caller against the target's text, then revealed: the same rules as serve-next (servePlace), under the list's claim.
// A business is READ, not consumed: one offer declining it leaves it to the brand's others; once served for the brand
// (any offer, any audience) it is taken for all. For an email reach the site is read BEFORE the offer, so a business
// that publishes no email is never handed to the judge, and the candidate carries the person the site names.

/** The snapshot the caller judges a business on: the business, and the person its site names when read. */
export function placeTeaser(place: GoogleMapsPlace, filters: GoogleMapsFilters, site: { contactName: string | null; contactRole: string | null } | null): TeaserSnapshot {
  const country = countryName(filters.country);
  const city = place.city ?? cityOfAddress(place.address, country);
  return {
    name: site?.contactName ?? null,
    title: site?.contactRole ?? null,
    headline: null,
    seniority: null,
    city,
    state: null,
    country,
    organizationName: place.name ?? null,
    organizationIndustry: place.category ?? null,
    organizationEmployees: null,
    organizationCity: city,
    organizationState: null,
    organizationCountry: country,
    organizationKeywords: place.categories && place.categories.length > 0 ? place.categories : null,
    organizationAddress: place.address ?? null,
  };
}

// The oldest business of the list this target has not decided yet, fit for the serve's channels, not taken for the
// brand. Not leased: the candidate row (unique per target and place) is the claim.
async function nextPlaceForTarget(target: AudienceRow, search: AudienceRow, fits: SQL): Promise<PlaceRow | null> {
  const [row] = await db
    .select()
    .from(googleMapsPlaces)
    .where(
      and(
        eq(googleMapsPlaces.audienceId, search.id),
        eq(googleMapsPlaces.status, "waiting"),
        fits,
        sql`not exists (select 1 from audience_candidates c where c.audience_id = ${target.id} and c.provider_person_id = ${googleMapsPlaces.placeId})`,
        sql`not exists (select 1 from audience_screened_out s where s.audience_id = ${target.id} and s.provider_person_id = ${googleMapsPlaces.placeId})`,
        sql`not exists (select 1 from google_maps_brand_claims k where k.org_id = ${search.orgId} and k.brand_id = ${search.brandId} and (k.place_id = ${googleMapsPlaces.placeId} or k.phone_e164 = ${googleMapsPlaces.phoneE164}))`
      )
    )
    .orderBy(asc(googleMapsPlaces.foundAt), asc(googleMapsPlaces.rank), asc(googleMapsPlaces.id))
    .limit(1);
  return row ?? null;
}

export type GoogleMapsCandidateResult = { status: "candidate"; row: AudienceCandidate } | { status: "exhausted" } | { status: "pending" };

/** The next business of a brand Google Maps list, offered to an offer audience (free, no verification, no claim). */
export async function nextGoogleMapsCandidate(
  target: AudienceRow,
  search: AudienceRow,
  identity: Identity,
  reach: readonly Reach[],
  reachableOn: readonly MessagingNetwork[],
  deadline: number
): Promise<GoogleMapsCandidateResult> {
  const filters = readGoogleMapsFilters(search.filters);
  const ch = serveChannels(reach, reachableOn, identity.acceptedEmails);
  if (!filters || !ch) return { status: "exhausted" };
  await seedGoogleMapsQueries(search, filters);
  const own = await loadOwnCompany(identity.orgId, [search.brandId]);
  const meters = new GoogleMapsMeters(identity, search.brandId, `/orgs/audiences/${target.id}/candidates/next`);
  let failed = false;
  try {
    while (Date.now() < deadline) {
      const row = await nextPlaceForTarget(target, search, ch.fits);
      if (!row) {
        if (await runNextQuery(search, filters, meters.search())) continue;
        console.log(`[human-service] offer_audience.google_maps_walked org=${identity.orgId} audience=${target.id} list=${search.id}`);
        return { status: "exhausted" };
      }
      const place = readPlace(row.place);
      if (isOwnCompany(own, { name: place.name ?? null, website: place.website ?? null })) {
        await decide(row.id, "own_company");
        continue;
      }
      let site: { contactName: string | null; contactRole: string | null } | null = null;
      if (ch.needEmail) {
        const read = row.emailStatus === null ? await readSiteOf(row, identity, meters) : null;
        if (typeof read === "string") continue;
        site = read ?? (await siteContactOf({ placeId: row.placeId, businessName: null, website: null, identity, meter: () => { throw new GoogleMapsSourceError(`site of ${row.placeId} not stored`); } }));
      }
      const [candidate] = await db
        .insert(audienceCandidates)
        .values({
          orgId: identity.orgId,
          audienceId: target.id,
          providerPersonId: row.placeId,
          linkedinUrl: null,
          teaser: placeTeaser(place, filters, site),
          organizationDomain: businessDomain(place.website),
          searchAudienceId: search.id,
          serveReach: { reachableBy: [...reach], reachableOn: [...reachableOn] },
        })
        .onConflictDoNothing({ target: [audienceCandidates.audienceId, audienceCandidates.providerPersonId] })
        .returning();
      if (!candidate) continue;
      console.log(
        `[human-service] offer_audience.google_maps_candidate_offered org=${identity.orgId} audience=${target.id} list=${search.id} candidate=${candidate.id} place=${row.placeId} email=${ch.needEmail ? "published" : "-"}`
      );
      return { status: "candidate", row: candidate };
    }
    return { status: "pending" };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await meters.close(failed);
  }
}

export type GoogleMapsRevealResult =
  | { status: "served"; person: Person; personId: string; emailVerdict: EmailVerdict | null; handBack: false }
  | { status: "not_served"; person: null; reason: GoogleMapsSkipReason | "brand_cannot_send"; verdict?: EmailVerdict; handBack: boolean };

/**
 * Reveal an offer audience's Google Maps candidate: the business decided and served exactly as serve-next would
 * (verification, WhatsApp check, the brand claim). The brand unable to send on WhatsApp hands it back.
 */
export async function revealGoogleMapsCandidate(
  search: AudienceRow,
  identity: Identity,
  placeId: string,
  reach: readonly Reach[],
  reachableOn: readonly MessagingNetwork[]
): Promise<GoogleMapsRevealResult> {
  const filters = readGoogleMapsFilters(search.filters);
  if (!filters) throw new GoogleMapsSourceError(`list ${search.id} holds no Google Maps searches`);
  const ch = serveChannels(reach, reachableOn, identity.acceptedEmails);
  if (!ch) return { status: "not_served", person: null, reason: "brand_cannot_send", handBack: true };
  const [row] = await db
    .select()
    .from(googleMapsPlaces)
    .where(and(eq(googleMapsPlaces.audienceId, search.id), eq(googleMapsPlaces.placeId, placeId)))
    .limit(1);
  if (!row) throw new GoogleMapsSourceError(`business ${placeId} is not in list ${search.id}`);
  if (row.status === "served") return { status: "not_served", person: null, reason: "taken", handBack: false };
  const own = await loadOwnCompany(identity.orgId, [search.brandId]);
  const meters = new GoogleMapsMeters(identity, search.brandId, `/orgs/audiences/${search.id}/candidates/reveal`);
  let failed = false;
  try {
    const out = await servePlace(search, row, identity, filters, own, ch, meters);
    if (out.kind === "served") return { status: "served", person: out.person, personId: out.personId, emailVerdict: out.verdict, handBack: false };
    if (out.kind === "brand_cannot_send") return { status: "not_served", person: null, reason: "brand_cannot_send", handBack: true };
    return { status: "not_served", person: null, reason: out.reason, ...(out.verdict ? { verdict: out.verdict } : {}), handBack: false };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await meters.close(failed);
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

/** still-fits for an email find: the business this audience served at that published address. */
export async function googleMapsStillFitsEmail(audienceId: string, email: string): Promise<boolean> {
  const norm = normalizeEmail(email);
  if (!norm) return false;
  const [row] = await db
    .select({ id: googleMapsPlaces.id })
    .from(googleMapsPlaces)
    .where(and(eq(googleMapsPlaces.audienceId, audienceId), eq(googleMapsPlaces.status, "served"), eq(googleMapsPlaces.email, norm)))
    .limit(1);
  return !!row;
}
