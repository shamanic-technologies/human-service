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
import { getApolloAudiencePreview, isLinkedinEngagementFilters } from "../lib/apollo-audiences.js";
import type { Identity } from "./people-providers.js";
import { isOwnCompany, loadOwnCompany, type OwnCompany } from "./own-company.js";

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

// What is stored on `audiences.preview`: the public sample plus, per person,
// the provider's reveal handle. The handle never leaves this service through
// the preview endpoint; only the email check reads it.
type StoredPreviewPerson = AudiencePreview["people"][number] & {
  providerPersonId?: string | null;
};
export type StoredAudiencePreview = Omit<AudiencePreview, "people"> & {
  people: StoredPreviewPerson[];
};

function toPublic(stored: StoredAudiencePreview, audienceId: string): AudiencePreview {
  return {
    ...stored,
    audienceId,
    people: stored.people.map((p) => ({
      firstName: p.firstName,
      lastNameObfuscated: p.lastNameObfuscated,
      title: p.title,
      company: p.company,
    })),
  };
}

// The brand's own company is never shown as a company or a person the audience
// reaches (src/services/own-company.ts). Applied on every read, so a sample
// stored before the rule existed is cleaned too. The sample only carries
// employer NAMES, so the match is on the name.
function withoutOwnCompany(stored: StoredAudiencePreview, own: OwnCompany): StoredAudiencePreview {
  return {
    ...stored,
    companies: stored.companies.filter((c) => !isOwnCompany(own, { name: c.name })),
    people: stored.people.filter((p) => !isOwnCompany(own, { name: p.company })),
  };
}

async function ownCompanyOfAudience(audience: AudienceRow): Promise<OwnCompany> {
  return loadOwnCompany(audience.orgId, [audience.brandId]);
}

export async function getAudiencePreview(
  audience: AudienceRow,
  identity: Identity
): Promise<AudiencePreview> {
  if (audience.preview) {
    const own = await ownCompanyOfAudience(audience);
    return toPublic(
      withoutOwnCompany(audience.preview as unknown as StoredAudiencePreview, own),
      audience.id
    );
  }
  const taken = await takeAudiencePreview(audience, identity);
  if (taken.status === "unavailable") return taken as AudiencePreview;
  return toPublic(withoutOwnCompany(taken, await ownCompanyOfAudience(audience)), audience.id);
}

// The stored sample WITH reveal handles, for the email check. A sample stored
// before apollo-service served handles is re-taken (the preview call is free
// and page 1 is deterministic, so the people are the same ones) and replaces
// the stored one. Unavailable answers are returned as-is and not stored.
export async function getRevealablePreview(
  audience: AudienceRow,
  identity: Identity
): Promise<StoredAudiencePreview> {
  const stored = audience.preview as unknown as StoredAudiencePreview | null;
  const own = await ownCompanyOfAudience(audience);
  if (stored && stored.people.every((p) => typeof p.providerPersonId === "string")) {
    return withoutOwnCompany({ ...stored, audienceId: audience.id }, own);
  }
  const taken = await takeAudiencePreview(audience, identity);
  return taken.status === "unavailable" ? taken : withoutOwnCompany(taken, own);
}

async function takeAudiencePreview(
  audience: AudienceRow,
  identity: Identity
): Promise<StoredAudiencePreview> {
  // linkedin_engagement is not an Apollo search: apollo-service has no free
  // sample for it (a named 400), so it is not previewable, like crm / apify.
  if (audience.provider !== "apollo" || isLinkedinEngagementFilters(audience.filters)) {
    return unavailable(audience.id, "provider_not_previewable");
  }
  if (!audience.apolloAudienceId) {
    // Not cached: the build lands later and the next call answers for real.
    return unavailable(audience.id, "not_built_yet");
  }

  const sample = await getApolloAudiencePreview(audience.apolloAudienceId, identity);
  const empty = sample.people.length === 0 && sample.companies.length === 0;
  const preview: StoredAudiencePreview = {
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
