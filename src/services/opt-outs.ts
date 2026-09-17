// Standing opt-outs on the serve path — "this person asked us to stop".
//
// Different from the per-brand suppression beside it in the two ways that matter,
// and neither is a tuning knob:
//
//   • It NEVER EXPIRES. The 3-month re-contact window is a timing rule about not
//     pestering the same person twice for one brand; nothing about the passage of
//     time withdraws a consent statement. Only an explicit withdrawal does, and
//     a withdrawn record puts the person straight back in the pool because the
//     exclusion is read live from the record itself.
//   • It is ORG-WIDE, not per brand. They asked the SENDER to stop, and the
//     sender is the org — honouring it for one brand while another brand of the
//     same org keeps writing is exactly the outcome that matters legally. So
//     these gates fire even when the request carries no brand at all, unlike
//     suppression, which is a no-op without brandIds.
//
// instantly-service OWNS the record (see lib/instantly-optouts). This module
// owns only the RESOLUTION: an opt-out is stated against an EMAIL, while the
// free apollo teaser masks the email and carries a linkedin url + an apollo
// person id. Both keys live on our own canonical `people` row for anyone this
// gateway has ever served, so resolving email → pre-pay keys is a local join on
// a table we own. That is identity resolution, not inference: the opt-out fact
// still comes from the record and nowhere else.
//
// Measured on production the day this shipped: 28 standing opt-outs across 7
// orgs, 21 of them resolvable to a `people` row and ALL 21 carrying a pre-pay
// key — so the free-teaser gate is the one that fires for three quarters of
// them. The remaining 7 (recorded for someone this gateway never served, e.g.
// an SMS about a lead from elsewhere) have no pre-pay key to match on and are
// caught by the email gates instead. Absent is absent; we never invent a key.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { people } from "../db/schema.js";
import {
  isEmailOptedOut,
  listStandingOptOutEmails,
} from "../lib/instantly-optouts.js";
import { normalizeEmail, normalizeLinkedinUrl } from "./suppression.js";
import type { Identity } from "./people-providers.js";

export { isEmailOptedOut, listStandingOptOutEmails };

// The org's standing opt-outs expressed in every identity key the serve path can
// match on BEFORE paying: the addresses themselves, plus the linkedin urls and
// provider person ids our own `people` rows tie those addresses to.
export interface OptOutExclusions {
  emails: Set<string>;
  linkedinUrls: Set<string>;
  personIds: Set<string>;
}

export const EMPTY_OPT_OUT_EXCLUSIONS: OptOutExclusions = {
  emails: new Set(),
  linkedinUrls: new Set(),
  personIds: new Set(),
};

export async function loadOptOutExclusions(
  identity: Identity
): Promise<OptOutExclusions> {
  const emails = await listStandingOptOutEmails(identity);
  if (emails.length === 0) return EMPTY_OPT_OUT_EXCLUSIONS;

  const rows = await db
    .select({
      linkedinUrlNorm: people.linkedinUrlNorm,
      apolloPersonId: people.apolloPersonId,
      apifyPersonId: people.apifyPersonId,
    })
    .from(people)
    .where(
      and(eq(people.orgId, identity.orgId), inArray(people.emailNorm, emails))
    );

  const linkedinUrls = new Set<string>();
  const personIds = new Set<string>();
  for (const r of rows) {
    if (r.linkedinUrlNorm) linkedinUrls.add(r.linkedinUrlNorm);
    if (r.apolloPersonId) personIds.add(r.apolloPersonId);
    if (r.apifyPersonId) personIds.add(r.apifyPersonId);
  }
  return { emails: new Set(emails), linkedinUrls, personIds };
}

// Does this candidate carry any key the org has a standing opt-out on? Every key
// present is checked; an absent one is simply not a match (never a reason to
// reject, and never a reason to pass either — the other keys still decide).
export function matchesOptOut(
  exclusions: OptOutExclusions,
  candidate: {
    email?: string | null;
    linkedinUrl?: string | null;
    providerPersonId?: string | null;
  }
): boolean {
  const email = normalizeEmail(candidate.email);
  if (email !== null && exclusions.emails.has(email)) return true;
  const linkedin = normalizeLinkedinUrl(candidate.linkedinUrl);
  if (linkedin !== null && exclusions.linkedinUrls.has(linkedin)) return true;
  if (
    candidate.providerPersonId &&
    exclusions.personIds.has(candidate.providerPersonId)
  )
    return true;
  return false;
}

// Drop every candidate the org holds a standing opt-out for. Org-scoped, so no
// brand argument and no window: this runs the same whether the request names a
// brand or not.
export function filterOptedOut<
  T extends {
    email?: string | null;
    linkedinUrl?: string | null;
    providerPersonId?: string | null;
  }
>(exclusions: OptOutExclusions, items: T[]): T[] {
  if (
    exclusions.emails.size === 0 &&
    exclusions.linkedinUrls.size === 0 &&
    exclusions.personIds.size === 0
  )
    return items;
  return items.filter((i) => !matchesOptOut(exclusions, i));
}
