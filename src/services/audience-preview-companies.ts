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
import { audiencePreviewCompanies, audiences } from "../db/schema.js";
import {
  APOLLO_COMPANIES_MAX,
  getApolloAudienceCompanies,
  isLinkedinEngagementFilters,
  type ApolloPreviewCompanyRow,
} from "../lib/apollo-audiences.js";
import { completeRun, createRun } from "./runs.js";
import { ProviderError, type Identity } from "./people-providers.js";
import type { AudiencePreviewReason } from "./audience-preview.js";
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
// companies (every employer already stored), so this bounds the walk; it is
// never reached on a real audience and fails loud if it is.
const MAX_CHUNKS_PER_CALL = 10;

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
}

type StoredPerson = PreviewCompanyPerson & { providerPersonId: string | null };

function readState(raw: unknown): BuildState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    apolloOffset: typeof o.apolloOffset === "number" ? o.apolloOffset : 0,
    done: o.done === true,
    matchCount: typeof o.matchCount === "number" ? o.matchCount : null,
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
async function ensureBuilt(audience: AudienceRow, identity: Identity, target: number): Promise<void> {
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
      if (chunks >= MAX_CHUNKS_PER_CALL) {
        throw new ProviderError(
          "apollo",
          502,
          `apollo-service returned ${MAX_CHUNKS_PER_CALL} company chunks without reaching ${target} rows for audience ${audience.id}`
        );
      }

      const apolloOffset = state?.apolloOffset ?? 0;
      const chunk = await getApolloAudienceCompanies(
        audience.apolloAudienceId!,
        apolloOffset,
        Math.min(Math.max(target - stored, 1), APOLLO_COMPANIES_MAX - apolloOffset),
        identity
      );

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
        fresh.push(r);
      }
      const toInsert = fresh.slice(0, PREVIEW_COMPANIES_MAX - stored);
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
  const tracking = {
    ...(identity.workflowTracking ?? {}),
    brandIds: [audience.brandId],
    audienceId: audience.id,
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

export async function getAudiencePreviewCompanies(
  audience: AudienceRow,
  identity: Identity,
  offset: number,
  limit: number
): Promise<AudiencePreviewCompanies> {
  if (audience.provider !== "apollo" || isLinkedinEngagementFilters(audience.filters)) {
    return unavailable(audience.id, "provider_not_previewable");
  }
  if (!audience.apolloAudienceId) return unavailable(audience.id, "not_built_yet");

  const target = Math.min(offset + limit, PREVIEW_COMPANIES_MAX);
  const current = readState(audience.previewCompaniesState);
  if (!current?.done && (await storedCount(audience.id)) < target) {
    await withRun(audience, identity, (runIdentity) => ensureBuilt(audience, runIdentity, target));
  }

  const [stateRow] = await db
    .select({ state: audiences.previewCompaniesState })
    .from(audiences)
    .where(eq(audiences.id, audience.id));
  const state = readState(stateRow?.state);
  const total = await storedCount(audience.id);
  const done = state?.done === true || total >= PREVIEW_COMPANIES_MAX;

  const rows = await db
    .select()
    .from(audiencePreviewCompanies)
    .where(
      and(
        eq(audiencePreviewCompanies.audienceId, audience.id),
        gte(audiencePreviewCompanies.idx, offset),
        lt(audiencePreviewCompanies.idx, Math.min(offset + limit, PREVIEW_COMPANIES_MAX))
      )
    )
    .orderBy(asc(audiencePreviewCompanies.idx));

  const end = done ? total : PREVIEW_COMPANIES_MAX;
  const nextOffset = offset + limit < end ? offset + limit : null;
  const empty = done && total === 0;

  return {
    audienceId: audience.id,
    status: empty ? "empty" : "ready",
    reason: empty ? "no_match" : null,
    rows: rows.map((r) => ({
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
  const checks = await loadCompanyRowChecks(audience.id);
  const byIndex = new Map(checks.map((c) => [c.personIndex, c]));
  return {
    audienceId: audience.id,
    maxCheckable: PREVIEW_COMPANIES_EMAIL_CHECK_MAX,
    checks: rows.map((r) => toCompanyRowCheck(r.idx, handleOf(r.person), byIndex.get(r.idx))),
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
