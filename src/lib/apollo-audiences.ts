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

export interface ApolloAudience {
  apolloAudienceId: string;
  filters: ApolloFilters;
  count: number;
}

function asApolloAudience(data: unknown, op: string): ApolloAudience {
  const o = (data ?? {}) as Record<string, unknown>;
  const apolloAudienceId = o.apolloAudienceId;
  const filters = o.filters;
  const count = o.count;
  if (
    typeof apolloAudienceId !== "string" ||
    apolloAudienceId.length === 0 ||
    !filters ||
    typeof filters !== "object" ||
    Array.isArray(filters) ||
    typeof count !== "number"
  ) {
    // A 2xx body that doesn't carry the contract is an apollo-service defect —
    // fail loud rather than persist a half-formed pointer.
    throw new ProviderError(
      "apollo",
      502,
      `apollo-service ${op} returned an unexpected body: ${JSON.stringify(o).slice(0, 200)}`
    );
  }
  return { apolloAudienceId, filters: filters as ApolloFilters, count };
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
