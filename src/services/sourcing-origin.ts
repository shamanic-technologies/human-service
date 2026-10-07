// WHERE A LEAD COMES FROM — the sourcing origin of an audience's list, as a
// features-service feature slug (e.g. `sourcing-apollo-cold-filters`).
//
// Every cent spent FINDING a lead is labelled with the origin that produced it,
// not with the outreach channel that later emails the lead. Two halves:
//   - SERVE: lead-service opens its serve run under the origin slug and forwards
//     it as x-feature-slug on serve-next. It asks us which origin first
//     (GET /orgs/audiences/{id}/sourcing-origin), because WE decide which source
//     serves (the CRM-outreach channel serves from crm-service whatever the
//     audience's provider). serve-next treats `sourcing-crm-contacts` exactly
//     like the CRM-outreach channel, so both labels serve the same person.
//   - LIST BUILDING: runs we open or forward to build / refill / preview an
//     audience's list carry that list's origin slug (`withSourcingOrigin`).
//
// features-service OWNS the list-kind -> origin mapping (its public
// `/public/sourcing-origins` catalogue); we read it, never re-type it. Cached
// 10 min; a failed read is not cached. Unresolvable ⟹ SourcingOriginError, never
// a fallback label (an unlabelled or mislabelled cent is the bug this exists to fix).

import type { Identity } from "./people-providers.js";
import { fetchSourcingOriginsByList, SourcingOriginError } from "../lib/features-sourcing.js";
import { audienceListKind } from "./audience-snapshot.js";
import type { AUDIENCE_LIST_KINDS } from "../schemas.js";

export { SourcingOriginError };

export type AudienceListKind = (typeof AUDIENCE_LIST_KINDS)[number];

// The features-service catalogue slugs of the outreach channel that sources from
// the client's CRM, and of the CRM origin. Byte-equal to features-service
// `src/seed/features.ts` / `src/lib/sourcing-origins.ts`. Constants (not a
// catalogue read) because serve-next routes on them: a serve must never depend on
// features-service being reachable.
export const CRM_OUTREACH_FEATURE_SLUG = "sales-crm-email-outreach";
export const CRM_CONTACTS_SOURCING_SLUG = "sourcing-crm-contacts";

// True when the request's feature identity says "serve from the client's CRM":
// the CRM outreach channel (old label) or the CRM origin (new label).
export function isCrmSourcedFeature(featureSlug: string | undefined): boolean {
  return featureSlug === CRM_OUTREACH_FEATURE_SLUG || featureSlug === CRM_CONTACTS_SOURCING_SLUG;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; byList: Map<string, string> } | null = null;

export function resetSourcingOriginCache(): void {
  cache = null;
}

async function loadCatalogue(): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.byList;
  const byList = await fetchSourcingOriginsByList();
  cache = { at: Date.now(), byList };
  return byList;
}

// The origin feature slug of a list kind. Throws when the catalogue names none.
export async function sourcingOriginSlug(list: AudienceListKind): Promise<string> {
  const slug = (await loadCatalogue()).get(list);
  if (!slug) {
    throw new SourcingOriginError(`features-service names no sourcing origin for audience list "${list}"`);
  }
  return slug;
}

// The list kind an origin slug IS (the catalogue read backwards), or null when the
// catalogue names no list for it. Source campaigns are keyed on the origin slug.
export async function listKindOfOriginSlug(slug: string): Promise<AudienceListKind | null> {
  for (const [list, origin] of await loadCatalogue()) {
    if (origin === slug) return list as AudienceListKind;
  }
  return null;
}

type AudienceShape = { id: string; provider: string | null; filters: unknown };

// The list a serve-next of this audience draws from, given the request's feature
// identity — the same decision serveNextPerson makes. null ⟹ not servable.
export function serveListKind(audience: AudienceShape, featureSlug: string | undefined): AudienceListKind | null {
  if (isCrmSourcedFeature(featureSlug)) return "crm_contacts";
  return audienceListKind(audience);
}

// The origin slug of an audience's own list (list building). Throws with the
// audience in context when it holds no list or the catalogue names no origin.
export async function audienceSourcingOriginSlug(audience: AudienceShape): Promise<string> {
  const list = audienceListKind(audience);
  if (!list) {
    throw new SourcingOriginError(`audience ${audience.id} has no committed provider, so no sourcing origin`);
  }
  return sourcingOriginSlug(list);
}

// The identity with its tracking block labelled with a sourcing origin, so the
// run we open AND every call forwarded under it carry the same slug (a child of
// a sourcing run must carry that slug, or runs-service 409s it).
export function withSourcingOrigin(identity: Identity, slug: string): Identity {
  return { ...identity, workflowTracking: { ...(identity.workflowTracking ?? {}), featureSlug: slug } };
}
