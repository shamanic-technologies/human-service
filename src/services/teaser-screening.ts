// Pre-pay teaser screening — what remains here after the screen moved out.
//
// Until 2026-10-07 serve-next judged every apollo free teaser against the
// audience's own text (one Jev `noul` question, paid only when P(yes) > the bar)
// BEFORE the billed reveal. Owner decision 2026-10-07: that judgement is
// QUALIFICATION and belongs to lead-service, which now takes each candidate from
// the candidate API (audience-candidates.ts), runs its own screen, and reveals or
// declines. human-service no longer asks the question.
//
// WHAT STAYS HERE, and why:
//   - toTeaserSnapshot: the judgeable slice of a teaser, stored at buffer time
//     (the candidate API hands it to lead-service).
//   - findScreenedOut: the silver `audience_screened_out` exclusion set (old
//     screen rejections + lead-service declines) dropped at buffer time.
//   - SCREEN_MIN_YES_PROBABILITY: the bar the historical bronze verdicts were
//     taken under; the staff snapshot reads "accepted" against it.
//   - the yield stop rule (isScreenYieldSpent), applied by the candidate path to
//     lead-service's decisions.
//
// LAYERING. Bronze `audience_teaser_screenings` keeps every historical verdict
// (readable via GET /orgs/audiences/{id}/screenings); silver
// `audience_screened_out` is the exclusion set the candidate path reads. Both
// keyed on the AUDIENCE, because a verdict is relative to that audience's target.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { audienceScreenedOut, type TeaserSnapshot } from "../db/schema.js";
import type { Person } from "./people-providers.js";

// A teaser is paid for only when Jev's probability that it belongs to the
// audience is ABOVE this. Strict: exactly 0.50 rejects.
//
// WHY 0.50 (owner decision, 2026-09-29). The bar started at 0.80 and almost
// nobody cleared it: on prompt v2 bronze, 147 of 5,758 teasers passed for one
// org (2.5%), 39 of 3,294 for another (1.2%), 3 of 817 for a Paraguay
// construction audience — while the real targets (a Works Director at a
// builder, a Construction Manager, a developer's Project Manager) sat at
// 0.5-0.78. Campaigns stalled on audience_exhausted with the right people
// rejected. Above 0.50 = the model thinks yes is more likely than no, which is
// what "belongs to the audience" means; the same populations pass at ~60-75%.
// The bar is written into each bronze row's `reason`, so verdicts taken under
// 0.80 stay readable against the bar that produced them.
export const SCREEN_MIN_YES_PROBABILITY = 0.5;

// Keywords are the one unbounded field on the snapshot; a long tail of them buys
// no signal and is paid for on every screen.
const MAX_KEYWORDS = 20;

// The judgeable slice of a provider Person, taken at buffer time. Everything
// here is carried verbatim; nothing is derived, defaulted or inferred, so an
// absent field reads as absent to the judge rather than as a fabricated value.
export function toTeaserSnapshot(person: Person): TeaserSnapshot {
  const org = person.organization;
  return {
    name: person.name ?? person.firstName,
    title: person.title,
    headline: person.headline,
    seniority: person.seniority,
    city: person.city,
    state: person.state,
    country: person.country,
    organizationName: org?.name ?? null,
    organizationIndustry: org?.industry ?? null,
    organizationEmployees: org?.estimatedNumEmployees ?? null,
    organizationCity: org?.city ?? null,
    organizationState: org?.state ?? null,
    organizationCountry: org?.country ?? null,
    organizationKeywords: org?.keywords ? org.keywords.slice(0, MAX_KEYWORDS) : null,
  };
}

// The provider person ids of an audience's already-rejected people, restricted
// to the candidates given. Used to drop them at BUFFER time so a rejected person
// is never re-buffered and never re-screened.
export async function findScreenedOut(
  audienceId: string,
  providerPersonIds: string[]
): Promise<Set<string>> {
  if (providerPersonIds.length === 0) return new Set();
  const rows = await db
    .select({ providerPersonId: audienceScreenedOut.providerPersonId })
    .from(audienceScreenedOut)
    .where(
      and(
        eq(audienceScreenedOut.audienceId, audienceId),
        inArray(audienceScreenedOut.providerPersonId, providerPersonIds)
      )
    );
  return new Set(rows.map((r) => r.providerPersonId));
}

// --- Screen yield: when an audience has stopped producing people ------------
//
// Apollo returns an audience's best matches first. An audience whose filters
// reach much further than its text (a title list with `include_similar_titles`)
// walks into a long tail the screen correctly rejects: Shockwavecenters' "US
// Chiropractic Clinicians" passed 2,200 of its first 2,500 teasers, then ~1-2%
// for the next 20,000, then ~0.1% (generic "Physician", "Resident Physician")
// for the last 10,000 — ~38,000 screens on 2026-10-01..04 for ~1,500 passes,
// the last 9,000 of them for 21 passes. Each screen is a billed Jev judgment and
// ~0.4s of a serve call; at 0.1% a call never reaches a pass inside its budget,
// so the campaign got `pending` for hours while the brand's other audiences sat
// idle.
//
// The rule: over the audience's last SCREEN_YIELD_WINDOW decisions under the
// current question, fewer than SCREEN_YIELD_MIN_PASSES passes ⟹ the audience is
// exhausted. Since 2026-10-07 the decisions are lead-service's (the candidate
// API's reveals / declines, see audience-candidates.ts `readCandidateYield`).
//
// WHY 1,000 / 3 (measured on every v2 verdict in prod, 2026-10-04, replaying the
// rule on each audience's own history): under the current bar it trips exactly
// one audience, Shockwavecenters' chiropractors, 1,088 screens into its current
// text, sparing the 9,320 screens that followed (21 passes in them). The most
// selective PRODUCTIVE stretch in the data (that same audience's 1-2% middle,
// ~12 passes per 1,000) never trips: falling under 3 when 12 are expected is a
// ~1-in-2,000 event per window. The only other trip in history was "European
// Union" under the retired 0.80 bar, which revived at 0.50 — why the window is
// keyed on the bar and the text: a new question starts a new window.
export const SCREEN_YIELD_WINDOW = 1000;
export const SCREEN_YIELD_MIN_PASSES = 3;

/** The stop rule on its own. A window that is not full yet never trips. */
export function isScreenYieldSpent(w: { screens: number; passes: number }): boolean {
  return w.screens >= SCREEN_YIELD_WINDOW && w.passes < SCREEN_YIELD_MIN_PASSES;
}
