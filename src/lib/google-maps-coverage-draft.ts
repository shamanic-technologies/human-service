// GMAPS-COVERAGE-1126: the ONE model call that writes a Google Maps list's next searches once every search it held
// ran (src/services/google-maps-coverage.ts owns when it is asked and what is done with the answer). chat-service
// owns the cost, org-billed with the serve's identity. tests/setup.ts answers it for every suite but the coverage one.

import { completeJson } from "./chat-client.js";
import type { Identity } from "../services/people-providers.js";

/** At most this many searches per coverage round. */
export const GOOGLE_MAPS_COVERAGE_ROUND_MAX = 40;

export interface CoverageSearchFact {
  query: string;
  places: number;
  newPlaces: number;
  /** The search returned as many places as its provider ever returns: more exist than it showed. */
  atCeiling: boolean;
}

export interface CoverageDraftInput {
  regionText: string;
  country: string;
  language: string;
  searches: CoverageSearchFact[];
  /** The towns the businesses found so far are in, with how many each holds (most first). */
  towns: Array<{ town: string; places: number }>;
}

export interface CoverageDraft {
  covered: boolean;
  reason: string;
  queries: string[];
}

const SYSTEM_PROMPT = [
  "You extend the Google Maps searches of a list of local businesses so that, together, they find every business the TARGET describes, everywhere in the region the TARGET names.",
  "You see every search already run, how many places each returned, how many were new to the list, and whether it hit the provider's result ceiling (it returned as many places as the provider ever returns, so more places exist than it showed). You also see the towns the places found so far are in.",
  "Write the next searches, most valuable first:",
  "1. For every search that hit the ceiling and was not split yet, finer searches with the same kind of business, one per district, neighbourhood, postal area or suburb of that place.",
  "2. The kinds of business the target names, in the towns and areas of the target region no search covered yet, the biggest towns first, down to small towns where such businesses exist.",
  "Each search reads like what a person types into Google Maps: the kind of business, then the place (\"Drogerie in Wil SG\").",
  "Never repeat a search already run, never a place outside the target region, never a kind of business the target does not describe.",
  `Write at most ${GOOGLE_MAPS_COVERAGE_ROUND_MAX} searches.`,
  "Answer covered=true with no searches only when the region is really covered: every town of the region where such businesses exist was searched for every kind of business, and every search that hit the ceiling was split. Say why in one sentence in reason.",
].join("\n");

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    covered: { type: "boolean" },
    reason: { type: "string" },
    queries: { type: "array", items: { type: "string" } },
  },
  required: ["covered", "reason", "queries"],
};

function renderInput(input: CoverageDraftInput): string {
  const searches = input.searches.map((s) => `- ${s.query} | places ${s.places} | new ${s.newPlaces}${s.atCeiling ? " | HIT THE CEILING" : ""}`);
  const towns = input.towns.map((t) => `- ${t.town}: ${t.places}`);
  return [
    `TARGET:\n${input.regionText}`,
    `COUNTRY: ${input.country}`,
    `LANGUAGE OF THE SEARCHES: ${input.language}`,
    `SEARCHES ALREADY RUN (${input.searches.length}):\n${searches.join("\n")}`,
    `TOWNS OF THE PLACES FOUND (${input.towns.length}):\n${towns.join("\n") || "- none"}`,
  ].join("\n\n");
}

export async function draftCoverageSearches(input: CoverageDraftInput, identity: Identity): Promise<CoverageDraft> {
  const out = await completeJson({
    message: renderInput(input),
    systemPrompt: SYSTEM_PROMPT,
    identity,
    responseSchema: RESPONSE_SCHEMA,
    provider: "anthropic",
    model: "sonnet",
    disableThinking: true,
  });
  if (typeof out.covered !== "boolean" || !Array.isArray(out.queries)) {
    throw new Error(`chat-service answered no coverage draft: ${JSON.stringify(out).slice(0, 300)}`);
  }
  const queries = (out.queries as unknown[]).filter((q): q is string => typeof q === "string" && q.trim().length > 0).map((q) => q.trim());
  return { covered: out.covered, reason: typeof out.reason === "string" ? out.reason : "", queries: queries.slice(0, GOOGLE_MAPS_COVERAGE_ROUND_MAX) };
}
