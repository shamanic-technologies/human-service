// The companies an audience reaches, with the firmographics a founder needs to
// judge fit, and the ONE person to write to at each — up to 100 rows, for a
// visitor who has not signed up yet (distribute.you /get-started).
//
// apollo-service owns the Apollo calls, which person is picked per company, and
// the cost (declared there, against the CALLER's org — the anonymous org when
// signed out). This module decides WHEN to ask and keeps the answer: rows are
// built one provider chunk at a time, only as far as the caller has paged, and
// stored in `audience_preview_companies` so a reload never pays twice. The
// audience's filters and apollo pointer are immutable, so stored rows never go
// stale against the audience they describe.
//
// Never an email or a phone. The person's reveal handle is stored but never
// returned. Not a serve: no suppression, no membership, no buffer, no cursor
// shared with serve-next. Declares no cost.

import { and, asc, count, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiencePreviewCompanies, audiences, googleMapsPlaces, type TeaserSnapshot } from "../db/schema.js";
import {
  APOLLO_COMPANIES_MAX,
  getApolloAudienceCompanies,
  isLinkedinEngagementFilters,
  type ApolloPreviewCompanyRow,
} from "../lib/apollo-audiences.js";
import { completeRun, createRun, TASK_SUPPORT } from "./runs.js";
import { audienceSourcingOriginSlug } from "./sourcing-origin.js";
import { ProviderError, type Identity } from "./people-providers.js";
import type { AudiencePreviewReason } from "./audience-preview.js";
import { isOwnCompany, loadOwnCompany, type OwnCompany } from "./own-company.js";
import { judgeAudienceFit, readStoredFit, type FitSubject } from "./audience-fit.js";
import { ensureTargetText, screenTarget } from "./audience-target-text.js";
import {
  businessDomain,
  cityOfAddress,
  countryName,
  GoogleMapsMeters,
  GOOGLE_MAPS_PROVIDER,
  readGoogleMapsFilters,
  readPlace,
  runNextQuery,
  seedGoogleMapsQueries,
  type GoogleMapsFilters,
} from "./google-maps-source.js";
import {
  claimEmailCheck,
  loadCompanyRowChecks,
  revealAndRecord,
  toCompanyRowCheck,
  type CompanyRowEmailCheck,
} from "./audience-preview-email-checks.js";

type AudienceRow = typeof audiences.$inferSelect;

// The owner's number: the list shows 100 companies, never more.
export const PREVIEW_COMPANIES_MAX = 100;
export const PREVIEW_COMPANIES_DEFAULT_LIMIT = 25;
// Provider chunks one call may walk to fill a page. A chunk can add zero new
// companies (every employer already stored, or every company judged out of the
// target), so this bounds the walk: past it the call serves what it has and the
// next page call walks on (`done` stays false).
const MAX_CHUNKS_PER_CALL = 10;
// Smallest chunk asked for: rows judged out of the target are not stored, so a
// one-row ask would walk the provider one company at a time.
const MIN_CHUNK = 10;

export interface PreviewCompany {
  name: string;
  domain: string | null;
  website: string | null;
  logoUrl: string | null;
  description: string | null;
  location: string | null;
  city: string | null;
  country: string | null;
  employeeCount: number | null;
  industry: string | null;
  linkedinUrl: string | null;
  foundedYear: number | null;
  annualRevenue: string | null;
  totalFunding: string | null;
  latestFundingStage: string | null;
  keywords: string[];
}

export interface PreviewCompanyPerson {
  firstName: string | null;
  lastNameObfuscated: string | null;
  title: string | null;
  linkedinUrl: string | null;
}

export interface AudiencePreviewCompanies {
  audienceId: string;
  status: "ready" | "empty" | "unavailable";
  reason: AudiencePreviewReason | null;
  rows: Array<{ index: number; company: PreviewCompany; person: PreviewCompanyPerson }>;
  totalAvailable: number;
  nextOffset: number | null;
  done: boolean;
  maxRows: number;
}

// `apolloOffset`: apollo-service's rank offset for the next chunk (its list is
// stable, so a chunk is asked for by offset). Distinct from the stored row
// count only if apollo-service ever repeats a company across chunks.
interface BuildState {
  apolloOffset: number;
  done: boolean;
  matchCount: number | null;
  /** Google Maps lists: businesses of the audience already considered, in walk order. */
  placesSeen?: number;
}

type StoredPerson = PreviewCompanyPerson & { providerPersonId: string | null };

function readState(raw: unknown): BuildState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    apolloOffset: typeof o.apolloOffset === "number" ? o.apolloOffset : 0,
    done: o.done === true,
    matchCount: typeof o.matchCount === "number" ? o.matchCount : null,
    ...(typeof o.placesSeen === "number" ? { placesSeen: o.placesSeen } : {}),
  };
}

function unavailable(audienceId: string, reason: AudiencePreviewReason): AudiencePreviewCompanies {
  return {
    audienceId,
    status: "unavailable",
    reason,
    rows: [],
    totalAvailable: 0,
    nextOffset: null,
    done: false,
    maxRows: PREVIEW_COMPANIES_MAX,
  };
}

// A company already stored is never stored twice, even if a later provider
// chunk lists it again.
function companyKey(c: { providerCompanyId?: string | null; domain: string | null; name: string }): string {
  if (c.providerCompanyId) return `id:${c.providerCompanyId}`;
  if (c.domain) return `domain:${c.domain.toLowerCase()}`;
  return `name:${c.name.trim().toLowerCase()}`;
}

async function storedCount(audienceId: string, tx: typeof db = db): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(audiencePreviewCompanies)
    .where(eq(audiencePreviewCompanies.audienceId, audienceId));
  return Number(r?.n ?? 0);
}

// Walk provider chunks until `target` rows are stored or the audience ran out.
// Serialized per audience by a transaction-scoped advisory lock, so two
// concurrent callers never pay for the same chunk: the second waits, then finds
// the rows already there.
// The brand's own company is never listed as a company to write to
// (src/services/own-company.ts).
function isOwnRow(own: OwnCompany, company: unknown): boolean {
  const c = company as Partial<ApolloPreviewCompanyRow["company"]>;
  return isOwnCompany(own, { name: c.name ?? null, domain: c.domain ?? null, website: c.website ?? null });
}

// What the shared fit judge sees for one row: the company and the person shown at it.
export function previewRowSnapshot(company: Record<string, unknown>, person: Record<string, unknown>): TeaserSnapshot {
  const c = company as unknown as Partial<ApolloPreviewCompanyRow["company"]> & { address?: string | null };
  const p = person as unknown as Partial<StoredPerson>;
  const name = [p.firstName, p.lastNameObfuscated].filter((x): x is string => !!x).join(" ") || null;
  return {
    name,
    title: p.title ?? null,
    headline: null,
    seniority: null,
    city: null,
    state: null,
    country: null,
    organizationName: c.name ?? null,
    organizationIndustry: c.industry ?? null,
    organizationEmployees: c.employeeCount ?? null,
    organizationCity: c.city ?? null,
    organizationState: null,
    organizationCountry: c.country ?? null,
    organizationKeywords: Array.isArray(c.keywords) && c.keywords.length > 0 ? c.keywords.slice(0, 20) : null,
    organizationAddress: c.location ?? null,
    organizationDescription: c.description ?? null,
  };
}

/** The judged subject of a row: its company and the person shown at it (another person = another subject). */
export function previewRowKey(company: Record<string, unknown>, person: Record<string, unknown>): string {
  const p = person as unknown as Partial<StoredPerson>;
  const who = p.providerPersonId ?? [p.firstName, p.title].filter(Boolean).join("|");
  return `${companyKey(company as unknown as ApolloPreviewCompanyRow["company"])}#${who || "-"}`;
}

export function previewSubjects(rows: Array<{ company: Record<string, unknown>; person: Record<string, unknown> }>): FitSubject[] {
  return rows.map((r) => ({ key: previewRowKey(r.company, r.person), snapshot: previewRowSnapshot(r.company, r.person) }));
}

/** The text every preview row is judged against (drafted now if the audience has none yet). */
async function previewTarget(audience: AudienceRow, identity: Identity): Promise<string | null> {
  const own = screenTarget(audience);
  if (own && audience.targetText) return own.text;
  const drafted = await ensureTargetText(audience, identity);
  return drafted ?? own?.text ?? null;
}

export interface PreviewBuildStats {
  /** Companies the provider handed us this call (after dedup and own company), each judged. */
  judged: number;
  /** Of those, the ones whose company is one of the target's. */
  companyFits: number;
  /** Rows stored (company AND person fit). */
  stored: number;
  /** apollo-credit charged by apollo-service this call (0 for a company in its 90-day cache). */
  creditsCharged: number;
}

async function ensureBuilt(
  audience: AudienceRow,
  identity: Identity,
  target: number,
  own: OwnCompany,
  fitTarget: string | null,
  maxChunks = MAX_CHUNKS_PER_CALL
): Promise<PreviewBuildStats> {
  const stats: PreviewBuildStats = { judged: 0, companyFits: 0, stored: 0, creditsCharged: 0 };
  await ensureBuiltInto(audience, identity, target, own, fitTarget, maxChunks, stats);
  return stats;
}

async function ensureBuiltInto(
  audience: AudienceRow,
  identity: Identity,
  target: number,
  own: OwnCompany,
  fitTarget: string | null,
  maxChunks: number,
  stats: PreviewBuildStats
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"preview-companies:" + audience.id}))`);

    for (let chunks = 0; ; chunks++) {
      const [row] = await tx
        .select({ state: audiences.previewCompaniesState })
        .from(audiences)
        .where(eq(audiences.id, audience.id));
      const state = readState(row?.state);
      const stored = await storedCount(audience.id, tx as unknown as typeof db);
      if (state?.done || stored >= target) return;
      if (chunks >= maxChunks) {
        console.log(
          `[human-service] preview_companies.walk_paused audience=${audience.id} chunks=${chunks} stored=${stored} target=${target}`
        );
        return;
      }

      const apolloOffset = state?.apolloOffset ?? 0;
      const chunk = await getApolloAudienceCompanies(
        audience.apolloAudienceId!,
        apolloOffset,
        Math.min(Math.max(target - stored, MIN_CHUNK), APOLLO_COMPANIES_MAX - apolloOffset),
        identity
      );
      stats.creditsCharged += chunk.creditsCharged;

      const existing = await tx
        .select({ company: audiencePreviewCompanies.company })
        .from(audiencePreviewCompanies)
        .where(eq(audiencePreviewCompanies.audienceId, audience.id));
      const seen = new Set(
        existing.map((e) => companyKey(e.company as unknown as ApolloPreviewCompanyRow["company"]))
      );

      const fresh: ApolloPreviewCompanyRow[] = [];
      for (const r of chunk.rows) {
        const k = companyKey(r.company);
        if (seen.has(k)) continue;
        seen.add(k);
        if (isOwnRow(own, r.company)) {
          console.log(
            `[human-service] own_company.blocked_preview_company audience=${audience.id} brand=${audience.brandId}`
          );
          continue;
        }
        fresh.push(r);
      }
      // Only a company the target describes, with a person the target says to write
      // to, is shown (the shared fit judgment, audience-fit.ts). The rest is judged,
      // stored as a verdict, and never listed; the cursor walks past it.
      let fitting = fresh;
      if (fitTarget) {
        const verdicts = await judgeAudienceFit({
          audienceId: audience.id,
          provider: "apollo",
          target: fitTarget,
          subjects: previewSubjects(fresh as unknown as Array<{ company: Record<string, unknown>; person: Record<string, unknown> }>),
          identity,
        });
        stats.judged += verdicts.length;
        stats.companyFits += verdicts.filter((v) => v.companyPasses).length;
        fitting = fresh.filter((_, i) => verdicts[i].passes);
      }
      const toInsert = fitting.slice(0, PREVIEW_COMPANIES_MAX - stored);
      stats.stored += toInsert.length;
      if (toInsert.length > 0) {
        await tx.insert(audiencePreviewCompanies).values(
          toInsert.map((r, i) => ({
            audienceId: audience.id,
            idx: stored + i,
            company: r.company as unknown as Record<string, unknown>,
            person: r.person as unknown as Record<string, unknown>,
          }))
        );
      }

      const nowStored = stored + toInsert.length;
      const done = chunk.nextOffset === null || nowStored >= PREVIEW_COMPANIES_MAX;
      // A chunk that moves nothing and promises more would loop forever.
      if (!done && chunk.nextOffset !== null && chunk.nextOffset <= apolloOffset) {
        throw new ProviderError(
          "apollo",
          502,
          `apollo-service company chunk did not advance its cursor for audience ${audience.id}`
        );
      }
      const next: BuildState = {
        apolloOffset: chunk.nextOffset ?? apolloOffset,
        done,
        matchCount: chunk.matchCount ?? state?.matchCount ?? null,
      };
      await tx
        .update(audiences)
        .set({ previewCompaniesState: next as unknown as Record<string, unknown> })
        .where(eq(audiences.id, audience.id));
    }
  });
}

// apollo-service requires an x-run-id (the paid lookup is declared on a child
// run of it). A caller that sends none gets a run of its own under its org, so
// the spend is still org-billed and traced. No run ⟹ fail loud.
async function withRun<T>(
  audience: AudienceRow,
  identity: Identity,
  fn: (identity: Identity) => Promise<T>
): Promise<T> {
  // The company table builds the audience's list: its run and every call under
  // it carry the list's sourcing origin (unresolvable ⟹ throws, nothing spent).
  const tracking = {
    ...(identity.workflowTracking ?? {}),
    brandIds: [audience.brandId],
    audienceId: audience.id,
    featureSlug: await audienceSourcingOriginSlug(audience),
  };
  const scoped: Identity = { ...identity, brandIds: [audience.brandId], workflowTracking: tracking };
  if (identity.runId) return fn(scoped);
  if (!identity.userId) {
    throw new ProviderError("apollo", 502, `audience ${audience.id}: no x-run-id and no user to open a run`);
  }
  const ownRunId = await createRun({
    orgId: identity.orgId,
    userId: identity.userId,
    taskName: "audience-preview-companies",
    support: TASK_SUPPORT["audience-preview-companies"],
    workflowTracking: tracking,
  });
  if (!ownRunId) {
    throw new ProviderError("apollo", 502, `audience ${audience.id}: runs-service did not open a run`);
  }
  const runIdentity = { orgId: identity.orgId, userId: identity.userId, workflowTracking: tracking };
  try {
    const out = await fn({ ...scoped, runId: ownRunId });
    await completeRun(ownRunId, "completed", runIdentity);
    return out;
  } catch (err) {
    await completeRun(ownRunId, "failed", runIdentity);
    throw err;
  }
}

function toPublicCompany(raw: Record<string, unknown>): PreviewCompany {
  const c = raw as unknown as ApolloPreviewCompanyRow["company"];
  return {
    name: c.name,
    domain: c.domain,
    website: c.website,
    logoUrl: c.logoUrl,
    description: c.description,
    location: c.location,
    city: c.city,
    country: c.country,
    employeeCount: c.employeeCount,
    industry: c.industry,
    linkedinUrl: c.linkedinUrl,
    foundedYear: c.foundedYear,
    annualRevenue: c.annualRevenue ?? null,
    totalFunding: c.totalFunding ?? null,
    latestFundingStage: c.latestFundingStage ?? null,
    keywords: Array.isArray(c.keywords) ? c.keywords : [],
  };
}

function toPublicPerson(raw: Record<string, unknown>): PreviewCompanyPerson {
  const p = raw as unknown as StoredPerson;
  return {
    firstName: p.firstName,
    lastNameObfuscated: p.lastNameObfuscated,
    title: p.title,
    linkedinUrl: p.linkedinUrl,
  };
}

// --- Google Maps lists: the businesses the audience's searches found, judged ---
//
// Same table, same page shape as an Apollo list: one row per business the shared fit
// judge accepts (the business is one of the target's; no person is known before its
// site is read, so the person fields are null). Businesses come from the audience's
// own `google_maps_places` (the provider measurement already ran its first search, so
// those are reused, never paid twice); when they run out the next search runs (metered,
// org-billed under the caller's run). `placesSeen` keeps the walk's position.

const PLACES_PER_STEP = 20;

export function placeCompany(raw: Record<string, unknown>, filters: GoogleMapsFilters): Record<string, unknown> {
  const place = readPlace(raw);
  const country = countryName(filters.country);
  const city = place.city ?? cityOfAddress(place.address, country);
  return {
    providerCompanyId: place.place_id ? `gmaps:${place.place_id}` : null,
    name: place.name ?? "",
    domain: businessDomain(place.website),
    website: place.website ?? null,
    logoUrl: null,
    description: null,
    location: place.address ?? null,
    city,
    country,
    employeeCount: null,
    industry: place.category ?? null,
    linkedinUrl: null,
    foundedYear: null,
    annualRevenue: null,
    totalFunding: null,
    latestFundingStage: null,
    keywords: place.categories ?? [],
  };
}

export const NO_PERSON: Record<string, unknown> = {
  providerPersonId: null,
  firstName: null,
  lastNameObfuscated: null,
  title: null,
  linkedinUrl: null,
};

/** Walk the audience's businesses until `target` fitting rows are stored or its searches ran out. */
export async function ensureGoogleMapsBuilt(
  audience: AudienceRow,
  identity: Identity,
  target: number,
  own: OwnCompany,
  fitTarget: string | null,
  maxSearches = 3
): Promise<PreviewBuildStats> {
  const stats: PreviewBuildStats = { judged: 0, companyFits: 0, stored: 0, creditsCharged: 0 };
  const filters = readGoogleMapsFilters(audience.filters);
  if (!filters) throw new ProviderError("google_maps", 502, `audience ${audience.id} holds no Google Maps searches`);
  await seedGoogleMapsQueries(audience, filters);
  const meters = new GoogleMapsMeters(identity, audience.brandId, `/orgs/audiences/${audience.id}/preview/companies`);
  let failed = false;
  try {
    let searches = 0;
    for (;;) {
      const [row] = await db
        .select({ state: audiences.previewCompaniesState })
        .from(audiences)
        .where(eq(audiences.id, audience.id));
      const state = readState(row?.state);
      const stored = await storedCount(audience.id);
      if (state?.done || stored >= target) return stats;
      const seen = state?.placesSeen ?? 0;
      const places = await db
        .select({ place: googleMapsPlaces.place, placeId: googleMapsPlaces.placeId })
        .from(googleMapsPlaces)
        .where(eq(googleMapsPlaces.audienceId, audience.id))
        .orderBy(asc(googleMapsPlaces.foundAt), asc(googleMapsPlaces.rank), asc(googleMapsPlaces.id))
        .offset(seen)
        // Only as many as the page still needs (each one is a judgment), at least a handful.
        .limit(Math.min(PLACES_PER_STEP, Math.max(target - stored, 5)));
      if (places.length === 0) {
        if (searches >= maxSearches) return stats;
        searches++;
        if (await runNextQuery(audience, filters, meters.search())) continue;
        await writeState(audience.id, { apolloOffset: 0, done: true, matchCount: null, placesSeen: seen });
        return stats;
      }
      const candidates = places
        .map((p) => ({ company: placeCompany(p.place as Record<string, unknown>, filters), person: NO_PERSON }))
        .filter((r) => (r.company.name as string).length > 0 && !isOwnRow(own, r.company));
      let fitting = candidates;
      if (fitTarget && candidates.length > 0) {
        const verdicts = await judgeAudienceFit({
          audienceId: audience.id,
          provider: GOOGLE_MAPS_PROVIDER,
          target: fitTarget,
          subjects: previewSubjects(candidates),
          identity,
        });
        stats.judged += verdicts.length;
        stats.companyFits += verdicts.filter((v) => v.companyPasses).length;
        fitting = candidates.filter((_, i) => verdicts[i].passes);
      }
      const toInsert = fitting.slice(0, PREVIEW_COMPANIES_MAX - stored);
      if (toInsert.length > 0) {
        await db
          .insert(audiencePreviewCompanies)
          .values(toInsert.map((r, i) => ({ audienceId: audience.id, idx: stored + i, company: r.company, person: r.person })))
          .onConflictDoNothing();
      }
      stats.stored += toInsert.length;
      await writeState(audience.id, {
        apolloOffset: 0,
        done: stored + toInsert.length >= PREVIEW_COMPANIES_MAX,
        matchCount: null,
        placesSeen: seen + places.length,
      });
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await meters.close(failed);
  }
}

async function writeState(audienceId: string, state: BuildState): Promise<void> {
  await db
    .update(audiences)
    .set({ previewCompaniesState: state as unknown as Record<string, unknown> })
    .where(eq(audiences.id, audienceId));
}

/** Build the first chunk of an Apollo list's companies (judged, the fitting ones stored as the
 * preview's first rows: the provider measurement's Apollo sample, never paid twice). */
export async function sampleApolloPreviewCompanies(
  audience: AudienceRow,
  identity: Identity,
  size: number,
  fitTarget: string
): Promise<PreviewBuildStats> {
  const own = await loadOwnCompany(audience.orgId, [audience.brandId]);
  return withRun(audience, identity, (runIdentity) => ensureBuilt(audience, runIdentity, size, own, fitTarget, 1));
}

export async function getAudiencePreviewCompanies(
  audience: AudienceRow,
  identity: Identity,
  offset: number,
  limit: number
): Promise<AudiencePreviewCompanies> {
  const googleMaps = audience.provider === GOOGLE_MAPS_PROVIDER;
  if (googleMaps) {
    if (!readGoogleMapsFilters(audience.filters)) return unavailable(audience.id, "not_built_yet");
  } else {
    if (audience.provider !== "apollo" || isLinkedinEngagementFilters(audience.filters)) {
      return unavailable(audience.id, "provider_not_previewable");
    }
    if (!audience.apolloAudienceId) return unavailable(audience.id, "not_built_yet");
  }

  const own = await loadOwnCompany(audience.orgId, [audience.brandId]);
  const fitTarget = await previewTarget(audience, identity);
  if (!fitTarget) {
    console.warn(`[human-service] preview_companies.no_target_text audience=${audience.id}: rows are not judged`);
  }
  const target = Math.min(offset + limit, PREVIEW_COMPANIES_MAX);
  const current = readState(audience.previewCompaniesState);
  if (!current?.done && (await storedCount(audience.id)) < target) {
    await withRun(audience, identity, (runIdentity) =>
      googleMaps
        ? ensureGoogleMapsBuilt(audience, runIdentity, target, own, fitTarget)
        : ensureBuilt(audience, runIdentity, target, own, fitTarget)
    );
  }

  const [stateRow] = await db
    .select({ state: audiences.previewCompaniesState })
    .from(audiences)
    .where(eq(audiences.id, audience.id));
  const state = readState(stateRow?.state);
  const storedTotal = await storedCount(audience.id);
  const done = state?.done === true || storedTotal >= PREVIEW_COMPANIES_MAX;
  // Rows stored before the own-company rule, or before the fit judgment
  // (AUDIENCE-SOURCE-BY-FIT-1126), are hidden on read, never served. A row
  // never judged is judged once here (stored, so never asked again).
  const all = await db
    .select()
    .from(audiencePreviewCompanies)
    .where(eq(audiencePreviewCompanies.audienceId, audience.id))
    .orderBy(asc(audiencePreviewCompanies.idx));
  const notOwn = all.filter((r) => !isOwnRow(own, r.company));
  const provider = googleMaps ? GOOGLE_MAPS_PROVIDER : "apollo";
  const pageRows = notOwn.filter((r) => r.idx >= offset && r.idx < Math.min(offset + limit, PREVIEW_COMPANIES_MAX));
  let hidden = new Set<number>();
  if (fitTarget) {
    const pageVerdicts = await judgeAudienceFit({
      audienceId: audience.id,
      provider,
      target: fitTarget,
      subjects: previewSubjects(pageRows),
      identity,
    });
    hidden = new Set(pageRows.filter((_, i) => !pageVerdicts[i].passes).map((r) => r.idx));
    const known = await readStoredFit(audience.id, provider, notOwn.map((r) => previewRowKey(r.company, r.person)));
    for (const r of notOwn) {
      const v = known.get(previewRowKey(r.company, r.person));
      if (v && !v.passes) hidden.add(r.idx);
    }
  }
  const total = notOwn.filter((r) => !hidden.has(r.idx)).length;

  const end = done ? storedTotal : PREVIEW_COMPANIES_MAX;
  const nextOffset = offset + limit < end ? offset + limit : null;
  const empty = done && total === 0;

  return {
    audienceId: audience.id,
    status: empty ? "empty" : "ready",
    reason: empty ? "no_match" : null,
    rows: pageRows.filter((r) => !hidden.has(r.idx)).map((r) => ({
      index: r.idx,
      company: toPublicCompany(r.company),
      person: toPublicPerson(r.person),
    })),
    totalAvailable: total,
    nextOffset,
    done,
    maxRows: PREVIEW_COMPANIES_MAX,
  };
}

// --- Per-row email check: can we REACH the person shown on a company row? ---
//
// Same billed reveal + verification as the /preview email checks (apollo-service
// declares the cost against the caller's org), keyed on the company row's
// index. Bounded: only the first PREVIEW_COMPANIES_EMAIL_CHECK_MAX rows can be
// checked, and a settled row is never re-revealed. Never returns an address.

export const PREVIEW_COMPANIES_EMAIL_CHECK_MAX = 10;

export class PreviewCompanyRowError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

async function loadRow(audienceId: string, index: number) {
  const [row] = await db
    .select()
    .from(audiencePreviewCompanies)
    .where(and(eq(audiencePreviewCompanies.audienceId, audienceId), eq(audiencePreviewCompanies.idx, index)));
  return row ?? null;
}

function handleOf(person: Record<string, unknown>): string | null {
  const h = (person as unknown as StoredPerson).providerPersonId;
  return typeof h === "string" && h.length > 0 ? h : null;
}

// Free read: where the check stands for every checkable row built so far.
export async function getCompanyRowEmailChecks(
  audience: AudienceRow
): Promise<{ audienceId: string; maxCheckable: number; checks: CompanyRowEmailCheck[] }> {
  const rows = await db
    .select()
    .from(audiencePreviewCompanies)
    .where(
      and(
        eq(audiencePreviewCompanies.audienceId, audience.id),
        lt(audiencePreviewCompanies.idx, PREVIEW_COMPANIES_EMAIL_CHECK_MAX)
      )
    )
    .orderBy(asc(audiencePreviewCompanies.idx));
  const own = await loadOwnCompany(audience.orgId, [audience.brandId]);
  const checks = await loadCompanyRowChecks(audience.id);
  const byIndex = new Map(checks.map((c) => [c.personIndex, c]));
  return {
    audienceId: audience.id,
    maxCheckable: PREVIEW_COMPANIES_EMAIL_CHECK_MAX,
    checks: rows
      .filter((r) => !isOwnRow(own, r.company))
      .map((r) => toCompanyRowCheck(r.idx, handleOf(r.person), byIndex.get(r.idx))),
  };
}

// Run the reveal for ONE row's person (unless already settled or in flight),
// persist the outcome, return that row's check.
export async function checkCompanyRowEmail(
  audience: AudienceRow,
  identity: Identity,
  index: number
): Promise<CompanyRowEmailCheck> {
  if (index >= PREVIEW_COMPANIES_EMAIL_CHECK_MAX) {
    throw new PreviewCompanyRowError(
      400,
      `Only the first ${PREVIEW_COMPANIES_EMAIL_CHECK_MAX} company rows can be email-checked`
    );
  }
  const row = await loadRow(audience.id, index);
  if (!row) {
    throw new PreviewCompanyRowError(404, `Company row ${index} is not built yet: page /preview/companies first`);
  }
  if (isOwnRow(await loadOwnCompany(audience.orgId, [audience.brandId]), row.company)) {
    throw new PreviewCompanyRowError(404, `Company row ${index} is the brand's own company`);
  }
  const handle = handleOf(row.person);
  if (!handle) {
    throw new PreviewCompanyRowError(409, `Company row ${index} carries no reveal handle`);
  }

  const current = async () => {
    const all = await loadCompanyRowChecks(audience.id);
    return toCompanyRowCheck(index, handle, all.find((c) => c.personIndex === index));
  };
  const before = await current();
  if (before.status !== "pending") return before;
  if (!(await claimEmailCheck(audience.id, index, handle, "companies"))) return current();

  await revealAndRecord(audience, identity, index, handle, "companies");
  return current();
}
