// A free sample of who an audience reaches — real companies and real people,
// never an email or a phone — for a visitor who has not signed up yet.
//
// apollo-service owns the Apollo call (a free people search on the audience's
// faithful filters); this module only decides WHEN to ask and keeps the answer
// on the audience row (`audiences.preview`) so a visitor reloading the page
// never causes a second provider call. The filters and the apollo pointer are
// immutable once set, so a stored sample never goes stale against the audience
// it describes.
//
// Writes nothing else: no serve, no suppression, no membership, no buffer.
// Declares no cost: the search behind it is free (apollo-service measured zero
// credit movement), and apollo-service owns it.

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences } from "../db/schema.js";
import { getApolloAudiencePreview } from "../lib/apollo-audiences.js";
import type { Identity } from "./people-providers.js";

type AudienceRow = typeof audiences.$inferSelect;

export type AudiencePreviewStatus = "ready" | "empty" | "unavailable";

// Why a preview carries no rows. `no_match`: the provider's search matched
// nobody. `not_built_yet`: an apollo audience whose provider-side filter set is
// still being built (a split audience right after confirm) — ask again shortly.
// `provider_not_previewable`: the audience is served from a source that has no
// free search to sample (a client's own CRM upload, the retired apify path).
export type AudiencePreviewReason =
  | "no_match"
  | "not_built_yet"
  | "provider_not_previewable";

export interface AudiencePreview {
  audienceId: string;
  status: AudiencePreviewStatus;
  reason: AudiencePreviewReason | null;
  matchCount: number | null;
  companies: Array<{ name: string; peopleInSample: number }>;
  people: Array<{
    firstName: string | null;
    lastNameObfuscated: string | null;
    title: string | null;
    company: string | null;
  }>;
  generatedAt: string | null;
}

function unavailable(
  audienceId: string,
  reason: AudiencePreviewReason
): AudiencePreview {
  return {
    audienceId,
    status: "unavailable",
    reason,
    matchCount: null,
    companies: [],
    people: [],
    generatedAt: null,
  };
}

export async function getAudiencePreview(
  audience: AudienceRow,
  identity: Identity
): Promise<AudiencePreview> {
  if (audience.preview) {
    return { ...(audience.preview as unknown as AudiencePreview), audienceId: audience.id };
  }
  if (audience.provider !== "apollo") {
    return unavailable(audience.id, "provider_not_previewable");
  }
  if (!audience.apolloAudienceId) {
    // Not cached: the build lands later and the next call answers for real.
    return unavailable(audience.id, "not_built_yet");
  }

  const sample = await getApolloAudiencePreview(audience.apolloAudienceId, identity);
  const empty = sample.people.length === 0 && sample.companies.length === 0;
  const preview: AudiencePreview = {
    audienceId: audience.id,
    status: empty ? "empty" : "ready",
    reason: empty ? "no_match" : null,
    matchCount: sample.count,
    companies: sample.companies,
    people: sample.people,
    generatedAt: new Date().toISOString(),
  };

  // Cache both "ready" and "empty": the filters are immutable, so an audience
  // that matched nobody keeps matching nobody.
  await db
    .update(audiences)
    .set({ preview: preview as unknown as Record<string, unknown> })
    .where(and(eq(audiences.id, audience.id), eq(audiences.orgId, audience.orgId)));

  return preview;
}
