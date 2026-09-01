// Client for apollo-service's faithful-Apollo-audience endpoints ("one filter
// vocabulary" Wave 2). human-service no longer holds Apollo's filter vocabulary:
// it stores a POINTER (apollo_audience_id) and sources the faithful filters /
// counts from apollo-service by id. apollo-service OWNS the NL->faithful-Apollo-
// filters agentic refine loop (and the chat-service LLM cost it incurs there), so
// human-service declares no cost here — it just routes + caches the opaque result.
//
// Reuses people-providers' single apollo HTTP layer (apolloPost / apolloGet —
// requireApollo + connect-phase retry + the downstream-header builder + the
// existing fail-loud ProviderError) so there is exactly ONE place that talks to
// apollo-service. Fail loud: a provider non-2xx / network error throws
// ProviderError (-> 502 at the route); a missing env throws ProviderConfigError.

import {
  apolloGet,
  apolloPost,
  ProviderError,
  type Identity,
} from "../services/people-providers.js";

// The faithful Apollo filter object is OPAQUE to human-service — apollo-service
// owns its shape (personTitles / qOrganizationIndustryTagIds / revenueRange /
// organizationNumEmployeesRanges / ... — Apollo's native people-search filters).
// We cache + forward it verbatim; we never build or validate it.
export type ApolloFilters = Record<string, unknown>;

// One sampled person from a candidate's live Apollo dry-run. Apollo's FREE
// people-search teaser redacts every location field, so employer + title is all
// there is (apollo-service#238) — do not expect a city/country here.
export interface ApolloCandidateSample {
  company: string | null;
  title: string | null;
}

// The explorer's own three one-sentence notes from the round that produced this
// candidate. Commentary on its own attempt, never a verdict on it.
export interface ApolloCandidateNotes {
  whatWorked: string | null;
  whatToImprove: string | null;
  nextExperiment: string | null;
}

// ONE round of apollo-service's refine loop, persisted and offered as a choice.
// apollo-service explores; it no longer decides which round wins — every
// mechanism it had for deciding degenerated, because a model grading its own
// proposal in isolation answers the same way every time. The decision lives in
// human-service now (src/services/audience-chooser.ts): choosing among N is
// COMPARATIVE, which is precisely what does not degenerate.
export interface ApolloCandidate {
  apolloAudienceId: string;
  filters: ApolloFilters;
  count: number;
  // Ten rows of WHO the filters actually matched. The chooser reads these; on
  // counts alone it reproduces the argmax that failed. Empty when apollo-service
  // sends none (legacy deploy) — never invented.
  sample: ApolloCandidateSample[];
  notes: ApolloCandidateNotes | null;
}

export interface ApolloAudience {
  apolloAudienceId: string;
  filters: ApolloFilters;
  count: number;
  status: string | null;
  // apollo-service's own verdict on the build: true when its refine loop judged
  // no candidate a good fit and returned the best attempt anyway rather than
  // failing (apollo-service#228). Additive on their side, so an older deploy may
  // omit it entirely — absent means "not flagged", i.e. false. Never an error,
  // and never a value we invent: only an explicit `true` degrades the audience.
  degraded: boolean;
  // Every round apollo-service explored, for the chooser to compare. apollo-
  // service's `candidates` array is ADDITIVE on its side, so a deploy that does
  // not send it yields exactly ONE candidate synthesised from the legacy
  // top-level `apolloAudienceId` / `filters` / `count` (with no sample and no
  // notes) — the pre-chooser behaviour, unchanged. Never empty.
  candidates: ApolloCandidate[];
}

function asSample(raw: unknown): ApolloCandidateSample[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    const company =
      typeof o.company === "string"
        ? o.company
        : typeof o.organization === "string"
          ? o.organization
          : null;
    const title = typeof o.title === "string" ? o.title : null;
    if (company === null && title === null) return [];
    return [{ company, title }];
  });
}

function asNotes(raw: unknown): ApolloCandidateNotes | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const notes = {
    whatWorked: str(o.whatWorked),
    whatToImprove: str(o.whatToImprove),
    nextExperiment: str(o.nextExperiment),
  };
  if (!notes.whatWorked && !notes.whatToImprove && !notes.nextExperiment) {
    return null;
  }
  return notes;
}

// Parse apollo-service's `candidates` array. A 2xx body carrying a `candidates`
// key whose entries do not hold (id, filters, count) is an apollo-service defect
// — fail loud rather than silently choose from a half-formed list.
function asCandidates(raw: unknown, op: string): ApolloCandidate[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c, i) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const apolloAudienceId =
      typeof o.apolloAudienceId === "string" && o.apolloAudienceId.length > 0
        ? o.apolloAudienceId
        : typeof o.audienceId === "string" && o.audienceId.length > 0
          ? o.audienceId
          : null;
    const filters = o.filters;
    const count = o.count;
    if (
      apolloAudienceId === null ||
      !filters ||
      typeof filters !== "object" ||
      Array.isArray(filters) ||
      typeof count !== "number"
    ) {
      throw new ProviderError(
        "apollo",
        502,
        `apollo-service ${op} returned an unusable candidate at index ${i}: ${JSON.stringify(o).slice(0, 200)}`
      );
    }
    return {
      apolloAudienceId,
      filters: filters as ApolloFilters,
      count,
      sample: asSample(o.sample ?? o.samples),
      notes: asNotes(o.notes),
    };
  });
}

function asApolloAudience(data: unknown, op: string): ApolloAudience {
  const o = (data ?? {}) as Record<string, unknown>;
  const apolloAudienceId = o.apolloAudienceId;
  const filters = o.filters;
  const count = o.count;
  const status = typeof o.status === "string" ? o.status : null;
  const degraded = o.degraded === true;
  if (
    typeof apolloAudienceId !== "string" ||
    apolloAudienceId.length === 0 ||
    !filters ||
    typeof filters !== "object" ||
    Array.isArray(filters) ||
    typeof count !== "number" ||
    count <= 0 ||
    status === "exhausted"
  ) {
    // A 2xx body that doesn't carry the contract is an apollo-service defect —
    // fail loud rather than persist a half-formed pointer.
    throw new ProviderError(
      "apollo",
      502,
      `apollo-service ${op} returned an unusable audience build: ${JSON.stringify(o).slice(0, 200)}`
    );
  }
  const parsed = asCandidates(o.candidates, op);
  return {
    apolloAudienceId,
    filters: filters as ApolloFilters,
    count,
    status,
    degraded,
    candidates:
      parsed.length > 0
        ? parsed
        : [
            {
              apolloAudienceId,
              filters: filters as ApolloFilters,
              count,
              sample: [],
              notes: null,
            },
          ],
  };
}

// POST /audiences/suggest-from-segment — run apollo-service's agentic
// NL->faithful-Apollo-filters refine loop and persist the confirmed audience.
// Returns the pointer + the faithful filters (to cache) + the live count.
export async function suggestApolloAudience(args: {
  name: string;
  description: string;
  brandId: string | null;
  identity: Identity;
}): Promise<ApolloAudience> {
  const data = await apolloPost(
    "/audiences/suggest-from-segment",
    { name: args.name, description: args.description, brandId: args.brandId },
    args.identity
  );
  return asApolloAudience(data, "suggest-from-segment");
}

// GET /audiences/{apolloAudienceId} — fetch a persisted apollo audience (faithful
// filters + count) by pointer. Used when a caller wants the live filters rather
// than the human-side cache.
export async function getApolloAudience(
  apolloAudienceId: string,
  identity: Identity
): Promise<ApolloAudience> {
  const data = await apolloGet(
    `/audiences/${encodeURIComponent(apolloAudienceId)}`,
    identity
  );
  return asApolloAudience(data, "get-audience");
}

// POST /audiences/{apolloAudienceId}/dry-run — free re-count of a persisted
// apollo audience by pointer (the count path for refresh-count / refresh on read).
export async function apolloAudienceDryRun(
  apolloAudienceId: string,
  identity: Identity
): Promise<{ count: number }> {
  const data = await apolloPost(
    `/audiences/${encodeURIComponent(apolloAudienceId)}/dry-run`,
    {},
    identity
  );
  const o = (data ?? {}) as Record<string, unknown>;
  if (typeof o.count !== "number") {
    throw new ProviderError(
      "apollo",
      502,
      `apollo-service dry-run returned no numeric count: ${JSON.stringify(o).slice(0, 200)}`
    );
  }
  return { count: o.count };
}
