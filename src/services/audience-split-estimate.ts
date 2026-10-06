// Approximate market size of proposed split segments, WITHOUT creating any
// audience. The signed-out /get-started page shows 4-8 proposed segments as
// cards and the visitor picks ONE; every card needs a size ("~41,000 people").
// Before this, the only way to get one was to confirm EVERY segment as a real
// audience and pay its full build (person-level target draft + apollo-service's
// agentic filter loop, ~$2.25 per visitor measured over 14 days) just to read
// a count off rows nobody would use.
//
// What runs, per call (the whole list, not per segment):
//   1. ONE cheap LLM call via chat-service (Gemini flash-pro, minimal thinking,
//      native JSON mode) drafts a set of Apollo People Search filters for every
//      segment at once. The vocabulary is apollo-service's OWN
//      `GET /search/filters-prompt` (its single source of truth for caller
//      LLMs), so human-service still holds no Apollo filter vocabulary.
//   2. One FREE apollo-service `POST /search/dry-run` per segment, in parallel
//      (no credit, no run, no DB write). apollo-service forces verified-email
//      only on every people search, so the number is reachable people.
//   3. Segments whose draft was rejected (400) or matched 0 get ONE repair
//      round: a second LLM call for those segments only, told what happened.
//
// Title inflation: Apollo's `include_similar_titles` defaults to true and
// inflates title-based counts ~10x, so it is FORCED false on every draft that
// names titles. The number is "people with a verified email matching a quick
// filter draft, exact titles": an order of magnitude, not the audience's final
// count (the confirmed audience's own build measures that).
//
// Cost: chat-service owns the LLM cost and bills the caller's org (identity
// headers forwarded; an `audience-split-estimate` run is opened when the caller
// sent no x-run-id). Dry-runs are free. human-service declares none.
//
// Persists nothing.

import {
  ChatServiceError,
  completeJson,
  type ChatIdentity,
} from "../lib/chat-client.js";
import {
  apolloGet,
  apolloPost,
  ProviderError,
  type Identity,
} from "./people-providers.js";
import { createRun, completeRun } from "./runs.js";

const ESTIMATE_LLM_PROVIDER = "google" as const;
const ESTIMATE_LLM_MODEL = "flash-pro";

export const MAX_ESTIMATE_SEGMENTS = 8;

export interface EstimateSegmentInput {
  name: string;
  description: string;
}

export type EstimateUnavailableReason =
  | "no_filters_drafted"
  | "filters_rejected";

export interface SegmentEstimate {
  name: string;
  /** Approximate count, rounded to 2 significant figures. null only with a reason. */
  estimatedPeople: number | null;
  unavailableReason: EstimateUnavailableReason | null;
}

// Filters keys the estimate never sends: a buying signal is a staff choice
// with its own audiences, never part of a cold segment's size.
const STRIPPED_KEYS = ["buying_signal"];

let cachedFiltersPrompt: { prompt: string; fetchedAt: number } | null = null;
const FILTERS_PROMPT_TTL_MS = 60 * 60 * 1000;

async function loadFiltersPrompt(identity: Identity): Promise<string> {
  if (
    cachedFiltersPrompt &&
    Date.now() - cachedFiltersPrompt.fetchedAt < FILTERS_PROMPT_TTL_MS
  ) {
    return cachedFiltersPrompt.prompt;
  }
  const data = (await apolloGet("/search/filters-prompt", identity)) as {
    prompt?: unknown;
  };
  if (typeof data.prompt !== "string" || data.prompt.length === 0) {
    throw new ProviderError("apollo", 502, "filters-prompt returned no prompt");
  }
  cachedFiltersPrompt = { prompt: data.prompt, fetchedAt: Date.now() };
  return data.prompt;
}

/** Test hook: forget the cached apollo filters prompt. */
export function resetFiltersPromptCache(): void {
  cachedFiltersPrompt = null;
}

/** Exported for the unit test that pins the prompt's invariants. */
export function buildEstimateSystemPrompt(filtersPrompt: string): string {
  return [
    "You translate audience segments into Apollo People Search filters, only to",
    "COUNT roughly how many people each segment holds. The count is shown to a",
    "prospect as an order of magnitude. Nobody is contacted from these filters.",
    "",
    "For EACH segment, write ONE filter object that captures exactly the people",
    "the segment sentence describes: the same kind of company, the same places,",
    "the same roles. Do not widen it and do not narrow it.",
    "",
    "RULES:",
    "  - Use ONLY field names and value formats from the reference below.",
    "  - Use 2 to 5 fields. Every field you add intersects with the others, so a",
    "    field the sentence does not ask for shrinks the count for nothing.",
    "  - Prefer company-level fields (industry, keyword tags, headcount ranges,",
    "    locations) and seniorities over long job title lists.",
    "  - When you use person_titles, list the common exact titles for the role",
    "    (several spellings). Similar-title matching is switched off.",
    "  - Never put a product or what the seller sells into the filters.",
    "  - Never use buying_signal.",
    "",
    "Answer JSON only, shaped exactly:",
    '{"segments":[{"index":<the segment number>,"filters":{...}}]}',
    "with one entry per segment you were given.",
    "",
    "=== APOLLO PEOPLE SEARCH FILTER REFERENCE ===",
    filtersPrompt,
  ].join("\n");
}

function segmentsMessage(segments: EstimateSegmentInput[], indexes: number[]): string {
  return indexes
    .map((i) => `Segment ${i + 1}: ${segments[i].name}\n${segments[i].description}`)
    .join("\n\n");
}

function repairMessage(
  segments: EstimateSegmentInput[],
  failures: Array<{ index: number; filters: Record<string, unknown> | null; problem: string }>
): string {
  return failures
    .map(
      (f) =>
        `Segment ${f.index + 1}: ${segments[f.index].name}\n${segments[f.index].description}\n` +
        `Your previous filters: ${JSON.stringify(f.filters)}\n` +
        `Problem: ${f.problem}\n` +
        "Write new filters for this segment that fix the problem (fewer or broader fields when it matched nobody)."
    )
    .join("\n\n");
}

function readDrafts(json: Record<string, unknown>): Map<number, Record<string, unknown>> {
  const out = new Map<number, Record<string, unknown>>();
  const list = json.segments;
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const { index, filters } = entry as { index?: unknown; filters?: unknown };
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) continue;
    out.set(index - 1, filters as Record<string, unknown>);
  }
  return out;
}

/** Exported for the unit test: what is actually sent to the dry-run. */
export function sanitizeDraftFilters(filters: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...filters };
  for (const k of STRIPPED_KEYS) delete out[k];
  delete out.includeSimilarTitles;
  const titles = out.person_titles ?? out.personTitles;
  if (Array.isArray(titles) && titles.length > 0) {
    out.include_similar_titles = false;
  } else {
    delete out.include_similar_titles;
  }
  return out;
}

/** Exported for the unit test: 2 significant figures, never 0 -> rounds to 0 only for 0. */
export function roundApproximate(n: number): number {
  if (n <= 0) return 0;
  const magnitude = Math.pow(10, Math.max(0, Math.floor(Math.log10(n)) - 1));
  return Math.round(n / magnitude) * magnitude;
}

type DryRunOutcome =
  | { kind: "count"; total: number }
  | { kind: "rejected"; problem: string };

async function dryRunCount(
  filters: Record<string, unknown>,
  identity: Identity
): Promise<DryRunOutcome> {
  try {
    const data = (await apolloPost("/search/dry-run", filters, identity)) as {
      totalEntries?: unknown;
    };
    if (typeof data.totalEntries !== "number") {
      throw new ProviderError("apollo", 502, "dry-run returned no totalEntries");
    }
    return { kind: "count", total: data.totalEntries };
  } catch (err) {
    // A 400 is apollo-service rejecting the DRAFT (unknown field, bad value):
    // the model's mistake, repairable. Anything else is the provider failing.
    if (err instanceof ProviderError && err.status === 400) {
      return { kind: "rejected", problem: `rejected by the search: ${err.body.slice(0, 500)}` };
    }
    throw err;
  }
}

async function withEstimateRun<T>(
  brandId: string,
  identity: Identity,
  fn: (identity: Identity) => Promise<T>
): Promise<T> {
  if (identity.runId) return fn(identity);
  if (!identity.userId) {
    throw new ChatServiceError(502, "no x-run-id and no user to open a run for the split estimate");
  }
  const tracking = { ...(identity.workflowTracking ?? {}), brandIds: [brandId] };
  const runId = await createRun({
    orgId: identity.orgId,
    userId: identity.userId,
    taskName: "audience-split-estimate",
    workflowTracking: tracking,
  });
  if (!runId) {
    throw new ChatServiceError(502, "runs-service did not open a run for the split estimate");
  }
  const runIdentity = { orgId: identity.orgId, userId: identity.userId, workflowTracking: tracking };
  try {
    const out = await fn({ ...identity, runId, workflowTracking: tracking });
    await completeRun(runId, "completed", runIdentity);
    return out;
  } catch (err) {
    await completeRun(runId, "failed", runIdentity);
    throw err;
  }
}

export async function estimateSplitSegments(
  brandId: string,
  segments: EstimateSegmentInput[],
  identity: Identity
): Promise<SegmentEstimate[]> {
  return withEstimateRun(brandId, identity, async (runIdentity) => {
    const filtersPrompt = await loadFiltersPrompt(runIdentity);
    const systemPrompt = buildEstimateSystemPrompt(filtersPrompt);
    const chatIdentity: ChatIdentity = runIdentity;

    const draft = async (message: string) =>
      readDrafts(
        await completeJson({
          message,
          systemPrompt,
          identity: chatIdentity,
          provider: ESTIMATE_LLM_PROVIDER,
          model: ESTIMATE_LLM_MODEL,
          disableThinking: true,
        })
      );

    const all = segments.map((_, i) => i);
    const filtersByIndex = await draft(segmentsMessage(segments, all));

    const measure = async (indexes: number[]) =>
      Promise.all(
        indexes.map(async (i) => {
          const raw = filtersByIndex.get(i);
          if (!raw) return { index: i, filters: null, outcome: null };
          const filters = sanitizeDraftFilters(raw);
          return { index: i, filters, outcome: await dryRunCount(filters, runIdentity) };
        })
      );

    const results = new Map<number, Awaited<ReturnType<typeof measure>>[number]>();
    for (const r of await measure(all)) results.set(r.index, r);

    const failures = [...results.values()]
      .filter((r) => !r.outcome || r.outcome.kind === "rejected" || r.outcome.total === 0)
      .map((r) => ({
        index: r.index,
        filters: r.filters,
        problem: !r.outcome
          ? "no filters were written for this segment"
          : r.outcome.kind === "rejected"
            ? r.outcome.problem
            : "these filters matched 0 people",
      }));

    if (failures.length > 0) {
      const repaired = await draft(repairMessage(segments, failures));
      for (const f of failures) {
        const raw = repaired.get(f.index);
        if (raw) filtersByIndex.set(f.index, raw);
      }
      for (const r of await measure(failures.map((f) => f.index))) {
        // Keep the first answer when the repair produced nothing better.
        const before = results.get(r.index);
        if (r.outcome && (r.outcome.kind === "count" || !before?.outcome)) results.set(r.index, r);
      }
    }

    return segments.map((s, i): SegmentEstimate => {
      const r = results.get(i);
      if (!r?.outcome) {
        return { name: s.name, estimatedPeople: null, unavailableReason: "no_filters_drafted" };
      }
      if (r.outcome.kind === "rejected") {
        return { name: s.name, estimatedPeople: null, unavailableReason: "filters_rejected" };
      }
      return {
        name: s.name,
        estimatedPeople: roundApproximate(r.outcome.total),
        unavailableReason: null,
      };
    });
  });
}
