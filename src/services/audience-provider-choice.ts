// AUDIENCE-SOURCE-BY-FIT-1126: a proposed (split) audience is sourced by the provider that
// MEASURED best for its target, never by a forced default.
//
// Before: every split audience was born `provider='apollo'`, whatever the target. "Brazilian
// restaurants" was searched on Apollo's company tags (half the companies were not restaurants)
// while Google Maps lists restaurants by construction; no Google Maps search was ever made.
//
// Now (owner rule, 2026-11-26: no special case, measured beats default):
// - Every provider that can SAMPLE a target is asked for a small sample of companies for this
//   audience: today Apollo (the first chunk of its companies list) and Google Maps (the first
//   searches its target expands to). apify is not deployed and a CRM list is the client's own
//   contacts (not a market search), so neither has a sample to give. A new provider joins by
//   adding a sampler to SAMPLERS, never by a rule about what the target is.
// - Each sampled company is judged against the audience's target text by the ONE shared fit
//   judgment (audience-fit.ts). Fit rate = companies that are the target's / companies sampled.
// - Cost per company = the provider's own price for finding one more company, read from
//   costs-service (Apollo: 1 apollo-credit per company record; Google Maps: the micro-USD its
//   searches actually charged, per business found). Cost per FITTING company = cost per company
//   / fit rate. The lowest wins (= most fitting companies per dollar). A provider with no
//   fitting company cannot win; none fits = the audience keeps its provider (said in the trace).
// - The choice is made ONCE (judged here, never by a consumer), persisted on
//   `audiences.chooser_trace.providerChoice`: every provider's sample size, fits, fit rate, unit
//   cost, cost per fitting company, the sampled companies with their verdicts, the winner and why.
// - Google Maps wins: the row becomes a Google Maps list (provider, its searches as filters;
//   the Apollo pointer is kept for audit). The businesses its sample found and the verdicts are
//   reused by the preview and the serve (never searched or judged twice). Apollo wins: the
//   sample's fitting companies are the preview's first rows.
//
// WHO is measured: audiences born `providerChoice.status = "pending"` (every split birth,
// audience-split.ts). Existing audiences are never re-sourced. WHEN: in the background right
// after the confirm, and awaited by the first preview / serve that needs the audience (deduped
// in flight, so the work runs once).

import { and, asc, count, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiencePreviewCompanies, audiences, googleMapsPlaces, googleMapsQueries } from "../db/schema.js";
import { platformPriceUsdCents } from "../lib/platform-prices.js";
import { ProviderError, type Identity } from "./people-providers.js";
import { judgeAudienceFit, readProviderFit } from "./audience-fit.js";
import { ensureTargetText, screenTarget } from "./audience-target-text.js";
import { ensureApolloPointer } from "./audiences.js";
import { recordNativeFilters } from "./profile-sources.js";
import { NO_PERSON, placeCompany, previewSubjects, sampleApolloPreviewCompanies } from "./audience-preview-companies.js";
import {
  draftGoogleMapsFilters,
  GoogleMapsMeters,
  GOOGLE_MAPS_PROVIDER,
  readGoogleMapsFilters,
  runNextQuery,
  seedGoogleMapsQueries,
  type GoogleMapsFilters,
} from "./google-maps-source.js";
import { completeRun, createRun, TASK_SUPPORT } from "./runs.js";
import { providerChoicePending, type ProviderChoiceMarker } from "../lib/provider-choice-marker.js";
export { pendingProviderChoice, providerChoicePending, readProviderChoice } from "../lib/provider-choice-marker.js";
import { audienceSourcingOriginSlug } from "./sourcing-origin.js";

type AudienceRow = typeof audiences.$inferSelect;

/** Companies sampled per provider. */
export const PROVIDER_SAMPLE_SIZE = 10;
/** Google Maps searches a sample may run to reach the sample size. */
const GOOGLE_MAPS_SAMPLE_SEARCHES = 2;

export interface ProviderSampleResult {
  provider: string;
  status: "measured" | "failed";
  sampled: number;
  fits: number;
  fitRate: number | null;
  /** What finding ONE more company costs on this provider, in USD (costs-service price). */
  unitCostUsd: number | null;
  /** What the sample itself was charged, in USD (0 when everything was cached / free). */
  sampleCostUsd: number | null;
  /** unitCostUsd / fitRate: dollars per company that is the target's. null = no fit / failed. */
  costPerFitUsd: number | null;
  costBasis: string;
  samples: Array<{ company: string | null; person: string | null; companyFit: string; personFit: string }>;
  error: string | null;
  /** Google Maps: the searches drafted for the target (reused if it wins). */
  googleMaps?: GoogleMapsFilters;
}

export interface ProviderChoiceTrace extends ProviderChoiceMarker {
  decidedAt?: string;
  target?: string | null;
  chosen?: string;
  previousProvider?: string | null;
  reason?: string;
  candidates?: ProviderSampleResult[];
}

// ─── The Apollo pointer a sample needs (deduped: the confirm fires it too) ─────────────────────

const nativeRecordsInFlight = new Map<string, Promise<AudienceRow>>();

/** A row born on its card's filters gets ONE apollo-service record from them (deduped in flight). */
export function ensureNativeRecord(row: AudienceRow, identity: Identity): Promise<AudienceRow> {
  if (row.apolloAudienceId) return Promise.resolve(row);
  const pending = nativeRecordsInFlight.get(row.id);
  if (pending) return pending;
  const p = (async () => {
    const [fresh] = await db.select().from(audiences).where(eq(audiences.id, row.id));
    if (fresh?.apolloAudienceId) return fresh;
    return recordNativeFilters(fresh ?? row, identity);
  })().finally(() => nativeRecordsInFlight.delete(row.id));
  nativeRecordsInFlight.set(row.id, p);
  return p;
}

async function readyApolloPointer(row: AudienceRow, identity: Identity): Promise<AudienceRow> {
  if (row.apolloAudienceId) return row;
  const filters = row.filters as Record<string, unknown> | null;
  const ready = filters && Object.keys(filters).length > 0 ? await ensureNativeRecord(row, identity) : await ensureApolloPointer(row, identity);
  if (!ready.apolloAudienceId) throw new ProviderError("apollo", 502, `audience ${row.id}: no Apollo list could be built to sample`);
  return ready;
}

// ─── Samplers: one per provider able to sample a target ───────────────────────────────────────

async function priceUsd(name: string): Promise<number> {
  return (await platformPriceUsdCents(name)) / 100;
}

function summarize(
  provider: string,
  verdicts: Array<{ companyPasses: boolean; companyFit: string; personFit: string }>,
  subjects: Array<{ company: string | null; person: string | null }>,
  unitCostUsd: number,
  sampleCostUsd: number,
  costBasis: string
): ProviderSampleResult {
  const sampled = verdicts.length;
  const fits = verdicts.filter((v) => v.companyPasses).length;
  const fitRate = sampled > 0 ? fits / sampled : null;
  return {
    provider,
    status: "measured",
    sampled,
    fits,
    fitRate,
    unitCostUsd,
    sampleCostUsd,
    costPerFitUsd: fitRate && fitRate > 0 ? unitCostUsd / fitRate : null,
    costBasis,
    samples: verdicts.map((v, i) => ({ ...subjects[i], companyFit: v.companyFit, personFit: v.personFit })),
    error: null,
  };
}

async function sampleApollo(row: AudienceRow, identity: Identity, target: string): Promise<ProviderSampleResult> {
  const ready = await readyApolloPointer(row, identity);
  const stats = await sampleApolloPreviewCompanies(ready, identity, PROVIDER_SAMPLE_SIZE, target);
  // The verdicts of the companies the sample walked (stored, so a re-run reads the same sample).
  const verdicts = (await readProviderFit(row.id, "apollo")).slice(0, Math.max(PROVIDER_SAMPLE_SIZE, stats.judged));
  const credit = await priceUsd("apollo-credit");
  return summarize(
    "apollo",
    verdicts,
    verdicts.map((v) => ({ company: v.company, person: v.person })),
    credit,
    stats.creditsCharged * credit,
    "1 apollo-credit per company record (costs-service price)"
  );
}

async function sampleGoogleMaps(row: AudienceRow, identity: Identity, target: string): Promise<ProviderSampleResult> {
  const filters = await draftGoogleMapsFilters(target, identity);
  const view = { ...row, provider: GOOGLE_MAPS_PROVIDER, filters: { google_maps: filters } } as AudienceRow;
  await seedGoogleMapsQueries(view, filters);
  const meters = new GoogleMapsMeters(identity, row.brandId, `/orgs/audiences/${row.id}/provider-choice`);
  let failed = false;
  try {
    for (let i = 0; i < GOOGLE_MAPS_SAMPLE_SEARCHES; i++) {
      const [c] = await db
        .select({ n: count() })
        .from(googleMapsPlaces)
        .where(eq(googleMapsPlaces.audienceId, row.id));
      if (Number(c?.n ?? 0) >= PROVIDER_SAMPLE_SIZE) break;
      if (!(await runNextQuery(view, filters, meters.search()))) break;
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await meters.close(failed);
  }
  const places = await db
    .select({ place: googleMapsPlaces.place })
    .from(googleMapsPlaces)
    .where(eq(googleMapsPlaces.audienceId, row.id))
    .orderBy(asc(googleMapsPlaces.foundAt), asc(googleMapsPlaces.rank), asc(googleMapsPlaces.id))
    .limit(PROVIDER_SAMPLE_SIZE);
  const rows = places
    .map((p) => ({ company: placeCompany(p.place as Record<string, unknown>, filters), person: NO_PERSON }))
    .filter((r) => (r.company.name as string).length > 0);
  const verdicts = await judgeAudienceFit({
    audienceId: row.id,
    provider: GOOGLE_MAPS_PROVIDER,
    target,
    subjects: previewSubjects(rows),
    identity,
  });
  const ran = await db
    .select({ chargedMicro: googleMapsQueries.chargedMicro, placesCount: googleMapsQueries.placesCount })
    .from(googleMapsQueries)
    .where(and(eq(googleMapsQueries.audienceId, row.id), isNotNull(googleMapsQueries.ranAt)));
  const micro = ran.reduce((a, q) => a + (q.chargedMicro ?? 0), 0);
  const found = ran.reduce((a, q) => a + (q.placesCount ?? 0), 0);
  const perMicro = await priceUsd("treg-micro-usd");
  const sampleCostUsd = micro * perMicro;
  const out = summarize(
    GOOGLE_MAPS_PROVIDER,
    verdicts,
    rows.map((r) => ({ company: (r.company.name as string) ?? null, person: null })),
    found > 0 ? sampleCostUsd / found : sampleCostUsd,
    sampleCostUsd,
    `searches charged ${micro} micro-USD for ${found} businesses (treg-micro-usd price)`
  );
  return { ...out, googleMaps: filters };
}

const SAMPLERS: Record<string, (row: AudienceRow, identity: Identity, target: string) => Promise<ProviderSampleResult>> = {
  apollo: sampleApollo,
  [GOOGLE_MAPS_PROVIDER]: sampleGoogleMaps,
};

/** The winner: the lowest cost per fitting company; a tie (or free providers) goes to the higher fit rate. */
export function pickProvider(results: ProviderSampleResult[]): ProviderSampleResult | null {
  const fit = results.filter((r) => r.status === "measured" && r.fits > 0 && r.costPerFitUsd !== null);
  if (fit.length === 0) return null;
  return [...fit].sort((a, b) => (a.costPerFitUsd! - b.costPerFitUsd!) || ((b.fitRate ?? 0) - (a.fitRate ?? 0)))[0];
}

// ─── The choice, made once ────────────────────────────────────────────────────────────────────

const choicesInFlight = new Map<string, Promise<AudienceRow>>();

/** The audience after its provider was chosen (measured now if still pending; a no-op otherwise). */
export function ensureProviderChoice(row: AudienceRow, identity: Identity): Promise<AudienceRow> {
  if (!providerChoicePending(row)) return Promise.resolve(row);
  const pending = choicesInFlight.get(row.id);
  if (pending) return pending;
  const p = (async () => {
    const [fresh] = await db.select().from(audiences).where(eq(audiences.id, row.id));
    if (!fresh) return row;
    if (!providerChoicePending(fresh)) return fresh;
    return withChoiceRun(fresh, identity, (runIdentity) => chooseProvider(fresh, runIdentity));
  })().finally(() => choicesInFlight.delete(row.id));
  choicesInFlight.set(row.id, p);
  return p;
}

// The sample spends (Apollo credits, Google Maps searches, Jev): under the caller's run, else
// a run of its own (org-billed, the row's creator when the caller names no user).
async function withChoiceRun<T>(row: AudienceRow, identity: Identity, fn: (identity: Identity) => Promise<T>): Promise<T> {
  const userId = identity.userId ?? row.createdByUserId ?? undefined;
  const tracking = {
    ...(identity.workflowTracking ?? {}),
    brandIds: [row.brandId],
    audienceId: row.id,
    featureSlug: await audienceSourcingOriginSlug(row),
  };
  const scoped: Identity = { ...identity, ...(userId ? { userId } : {}), brandIds: [row.brandId], workflowTracking: tracking };
  if (identity.runId) return fn(scoped);
  if (!userId) throw new ProviderError("apollo", 502, `audience ${row.id}: no run and no user to measure its providers`);
  const runId = await createRun({
    orgId: identity.orgId,
    userId,
    taskName: "audience-provider-choice",
    support: TASK_SUPPORT["audience-provider-choice"],
    workflowTracking: tracking,
  });
  if (!runId) throw new ProviderError("apollo", 502, `audience ${row.id}: runs-service did not open a run`);
  const runIdentity = { orgId: identity.orgId, userId, workflowTracking: tracking };
  try {
    const out = await fn({ ...scoped, runId });
    await completeRun(runId, "completed", runIdentity);
    return out;
  } catch (err) {
    await completeRun(runId, "failed", runIdentity);
    throw err;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function chooseProvider(row: AudienceRow, identity: Identity): Promise<AudienceRow> {
  const own = screenTarget(row);
  const target = row.targetText ? own?.text ?? null : (await ensureTargetText(row, identity)) ?? own?.text ?? null;
  const previous = row.provider;
  if (!target) {
    return persistChoice(row, {
      status: "decided",
      decidedAt: new Date().toISOString(),
      target: null,
      chosen: previous ?? "apollo",
      previousProvider: previous,
      reason: "no target text to judge companies against: the audience keeps its provider",
      candidates: [],
    }, null);
  }

  const results = await Promise.all(
    Object.entries(SAMPLERS).map(async ([provider, sample]): Promise<ProviderSampleResult> => {
      try {
        return await sample(row, identity, target);
      } catch (err) {
        console.error(`[human-service] provider_choice.sample_failed audience=${row.id} provider=${provider}: ${messageOf(err)}`);
        return {
          provider, status: "failed", sampled: 0, fits: 0, fitRate: null, unitCostUsd: null, sampleCostUsd: null,
          costPerFitUsd: null, costBasis: "", samples: [], error: messageOf(err).slice(0, 500),
        };
      }
    })
  );
  if (results.every((r) => r.status === "failed")) {
    // Nothing measured: never a choice made blind. Stays pending (the next preview / serve asks again).
    throw new ProviderError("apollo", 502, `audience ${row.id}: no provider could be sampled (${results.map((r) => `${r.provider}: ${r.error}`).join("; ")})`);
  }
  const winner = pickProvider(results);
  const chosen = winner?.provider ?? previous ?? "apollo";
  const reason = winner
    ? `${winner.provider} finds a company of the target for $${winner.costPerFitUsd!.toFixed(5)} (fit ${winner.fits}/${winner.sampled}), the lowest of the providers sampled`
    : "no sampled company of any provider is one of the target's: the audience keeps its provider";
  const trace: ProviderChoiceTrace = {
    status: "decided",
    decidedAt: new Date().toISOString(),
    target,
    chosen,
    previousProvider: previous,
    reason,
    candidates: results,
  };
  console.log(
    `[human-service] provider_choice.decided org=${row.orgId} audience=${row.id} chosen=${chosen} ${results.map((r) => `${r.provider}=${r.status}:${r.fits}/${r.sampled}@${r.costPerFitUsd ?? "-"}`).join(" ")}`
  );
  const gm = results.find((r) => r.provider === GOOGLE_MAPS_PROVIDER)?.googleMaps ?? null;
  return persistChoice(row, trace, chosen === GOOGLE_MAPS_PROVIDER && chosen !== previous ? gm : null);
}

async function persistChoice(row: AudienceRow, trace: ProviderChoiceTrace, switchToGoogleMaps: GoogleMapsFilters | null): Promise<AudienceRow> {
  const chooserTrace = { ...((row.chooserTrace as Record<string, unknown> | null) ?? {}), providerChoice: trace };
  return db.transaction(async (tx) => {
    if (switchToGoogleMaps) {
      // The Apollo sample's rows were the losing provider's: the preview is rebuilt from the
      // businesses the Google Maps sample already found (and judged).
      await tx.delete(audiencePreviewCompanies).where(eq(audiencePreviewCompanies.audienceId, row.id));
    }
    const [updated] = await tx
      .update(audiences)
      .set({
        chooserTrace,
        ...(switchToGoogleMaps
          ? {
              provider: GOOGLE_MAPS_PROVIDER,
              filters: { google_maps: switchToGoogleMaps } as Record<string, unknown>,
              apolloCount: null,
              countedAt: null,
              preview: null,
              previewCompaniesState: null,
              updatedAt: new Date(),
            }
          : {}),
      })
      .where(eq(audiences.id, row.id))
      .returning();
    if (switchToGoogleMaps && !readGoogleMapsFilters(updated?.filters)) {
      throw new ProviderError(GOOGLE_MAPS_PROVIDER, 502, `audience ${row.id}: the Google Maps searches did not persist`);
    }
    return updated ?? row;
  });
}
