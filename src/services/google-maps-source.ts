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
  audienceMembers,
  audiences,
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
  const city = cityOfAddress(place.address, country);
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

export async function serveNextGoogleMaps(
  audience: AudienceRow,
  identity: Identity,
  reach: readonly Reach[],
  reachableOn: readonly MessagingNetwork[],
  deadline: number
): Promise<GoogleMapsServeResult> {
  const filters = readGoogleMapsFilters(audience.filters);
  if (!filters) throw new GoogleMapsSourceError(`audience ${audience.id} holds no Google Maps searches`);
  const onWhatsapp = reachableOn.includes("whatsapp");
  const unsupported = reachableOn.filter((n) => n !== "whatsapp");
  if (unsupported.length > 0) {
    // No owner answers "is this number on <network>" for these yet: never served on a guess.
    console.log(`[human-service] google_maps.network_not_checkable org=${identity.orgId} audience=${audience.id} reachableOn=${unsupported.join(",")}`);
    return { status: "exhausted", person: null };
  }
  // The channels this serve needs: an email pipe needs the published address; every
  // other serve (phone, WhatsApp, none stated) needs the phone, as before.
  const needEmail = reach.includes("email");
  const needPhone = reach.includes("phone") || onWhatsapp || !needEmail;
  const accepted = googleMapsAcceptedVerdicts(identity.acceptedEmails);
  const fits = and(
    needPhone ? sql`phone_e164 is not null` : sql`true`,
    needEmail
      ? sql`(email_status is null or (email_status = 'found' and (email_verdict is null or email_verdict in (${sql.join(accepted.map((v) => sql`${v}`), sql`, `)}))))`
      : sql`true`
  )!;

  await seedGoogleMapsQueries(audience, filters);
  const own = await loadOwnCompany(identity.orgId, [audience.brandId]);
  const meterIdentity = () => {
    if (!identity.runId || !identity.userId) {
      throw new GoogleMapsSourceError("a Google Maps search or site read is paid: serve-next needs x-run-id and x-user-id", 400);
    }
    return { orgId: identity.orgId, userId: identity.userId, runId: identity.runId, brandIds: [audience.brandId], campaignId: identity.campaignId, workflowTracking: identity.workflowTracking };
  };
  let meter: TregMeter | null = null;
  let siteMeter: TregMeter | null = null;
  let failed = false;
  try {
    while (Date.now() < deadline) {
      const row = await takePlace(audience.id, fits);
      if (!row) {
        meter ??= new TregMeter(meterIdentity(), "google-maps-search", `/orgs/audiences/${audience.id}/serve-next`);
        if (await runNextQuery(audience, filters, meter)) continue;
        await persistGoogleMapsReachable(audience);
        console.log(`[human-service] google_maps.exhausted org=${identity.orgId} audience=${audience.id} queries=${filters.queries.length} reach=${reach.join(",") || "-"}`);
        return { status: "exhausted", person: null };
      }

      const place = row.place as GoogleMapsPlace;
      if (isOwnCompany(own, { name: place.name ?? null, website: place.website ?? null })) {
        await decide(row.id, "own_company");
        continue;
      }
      if (await brandAlreadyHas(audience.orgId, audience.brandId, row.placeId, row.phoneE164)) {
        await decide(row.id, "taken");
        continue;
      }

      let contact: PlaceEmail | null = null;
      if (needEmail) {
        let email = row.email;
        let site: SiteContact | null = null;
        if (row.emailStatus === null) {
          site = await siteContactOf({
            placeId: row.placeId,
            businessName: place.name ?? null,
            website: place.website ?? null,
            identity,
            meter: () => (siteMeter ??= new TregMeter(meterIdentity(), "google-maps-site-read", `/orgs/audiences/${audience.id}/serve-next`)),
          }).catch(async (err) => {
            await decide(row.id, "waiting");
            throw err;
          });
          if (site.outcome !== "found" || !site.email) {
            await setEmailState(row.id, { emailStatus: site.outcome, email: null });
            continue;
          }
          email = site.email;
        }
        if (!email) {
          await setEmailState(row.id, { emailStatus: "no_email", email: null });
          continue;
        }
        // The fleet's email facts about this address, before paying to verify it.
        const brandIdentity = { ...identity, brandIds: [audience.brandId] };
        if (await isEmailSuppressed(audience.orgId, [audience.brandId], email, identity.excludeEmailedWithin)) {
          await decide(row.id, "taken");
          continue;
        }
        if (await isPersonOptedOut(brandIdentity, email)) {
          await decide(row.id, "opted_out");
          continue;
        }
        if (await isEmailWonForRequest(brandIdentity, email)) {
          await decide(row.id, "won");
          continue;
        }
        if (await isEmailBounced(brandIdentity, email)) {
          await setEmailState(row.id, { emailStatus: "not_deliverable", email, emailVerdict: "invalid" });
          continue;
        }
        const verdict = (row.emailVerdict as EmailVerdict | null) ?? (await verifyEmail(email, identity).catch(async (err) => {
          await decide(row.id, "waiting");
          throw err;
        }));
        if (!accepted.includes(verdict)) {
          await setEmailState(row.id, { emailStatus: verdict === "invalid" || verdict === "risky" ? "not_deliverable" : "found", email, emailVerdict: verdict });
          continue;
        }
        await db.update(googleMapsPlaces).set({ emailStatus: "found", email, emailVerdict: verdict }).where(eq(googleMapsPlaces.id, row.id));
        // Same read as the stored row when the site was read on an earlier serve.
        const named = site ?? (await siteContactOf({ placeId: row.placeId, businessName: null, website: null, identity, meter: () => { throw new GoogleMapsSourceError(`site of ${row.placeId} not stored`); } }));
        contact = { email, verdict, contactName: named.contactName, contactRole: named.contactRole };
      }

      if (onWhatsapp && row.phoneE164) {
        const wa = await crmWhatsappReach(audience.brandId, row.phoneE164, identity).catch(async (err) => {
          await decide(row.id, "waiting");
          throw err;
        });
        if (!wa.reachable) {
          if (wa.code === "not_on_whatsapp" || wa.code === "stated_not_to_brand") {
            await decide(row.id, wa.code);
            continue;
          }
          // The BRAND cannot send on WhatsApp now: nobody is consumed.
          await decide(row.id, "waiting");
          console.warn(`[human-service] google_maps.whatsapp_unavailable org=${identity.orgId} audience=${audience.id} brand=${audience.brandId} code=${wa.code}: ${wa.error}`);
          return { status: "exhausted", person: null };
        }
      }
      const person = placeToPerson(place, row.phoneE164, filters, contact);
      const personId = await claimAndServe(audience, identity, row, person, contact?.verdict ?? null);
      if (!personId) {
        await decide(row.id, "taken");
        continue;
      }
      console.log(`[human-service] google_maps.served org=${identity.orgId} audience=${audience.id} place=${row.placeId} email=${contact ? contact.verdict : "-"} named=${contact?.contactName ? "yes" : "no"} run=${identity.runId ?? "-"}`);
      return { status: "served", person, personId };
    }
    return { status: "pending", person: null };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (meter) await meter.close(failed ? "failed" : "completed");
    if (siteMeter) await (siteMeter as TregMeter).close(failed ? "failed" : "completed");
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
