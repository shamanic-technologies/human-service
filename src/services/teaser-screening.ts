// Pre-pay teaser screening — judge an apollo free teaser against the audience
// the customer asked for, in THIS audience's own text (`audiences.target_text`,
// see audience-target-text.ts; `nl_prompt` until it is written), BEFORE
// spending the credit that reveals its email.
//
// WHY THIS EXISTS. An apollo audience is a pointer to a faithful Apollo filter
// set, and Apollo's vocabulary cannot express every constraint an audience
// states in plain English: "chiropractors who own their practice", "German-
// speaking Switzerland", "shops that stock the product" have no field. So a
// teaser can satisfy every filter and still be the wrong person — and without
// this we learn it only after the apollo credit, the generated email and the
// send are all spent on them.
//
// WHERE IT SITS. Exactly at the frontier between free and billed: serve-next
// pops a free teaser, we judge it, and only a pass reaches `resolveEmail`. One
// question per person, never a batch.
//
// HOW IT DECIDES (v2). One Jev `noul` question through chat-service
// /orgs/judgments: "does this person belong to this audience?". Jev returns the
// model's own probability that the answer is YES, and the teaser passes ONLY
// when that probability is above SCREEN_MIN_YES_PROBABILITY. Everything else —
// a no, a hesitant yes — is rejected before the reveal. No guidance in the
// question about what to do when unsure: the threshold IS that decision.
//
// v1 (2026-09-17 → 2026-09-28) asked glm-flash via /complete for a bare
// boolean against the LLM-written `description`, with "borderline cases are a
// yes" in its prompt. On LivingVital's "Swiss Health Shop Employees" it passed
// 199 of 285 teasers, ~51 of them Galenica HQ staff (Group CFO, HR, recruiters,
// engineers). Three causes, all removed here: no confidence to threshold, a
// target that described Apollo mechanics instead of the customer's intent, and
// a prompt that licensed the passes.
//
// LAYERING. Bronze `audience_teaser_screenings` records EVERY verdict (passes
// included) with the snapshot, the yes-probability, the serving model and the
// prompt version; silver `audience_screened_out` is the exclusion set the serve
// path reads. Both are written in ONE transaction, so a rejection can never
// exist without the evidence that produced it. Keyed on the AUDIENCE, because
// the verdict is relative to the target that audience defined.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  audienceScreenedOut,
  audienceTeaserScreenings,
  type TeaserSnapshot,
} from "../db/schema.js";
import { judgeYesNo, type ChatIdentity } from "../lib/chat-client.js";
import type { Person } from "./people-providers.js";
import { screenTarget } from "./audience-target-text.js";

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

// Bump when the question changes. Stored on every bronze row so a later verdict
// can be read against the question that produced it rather than the current one.
export const SCREEN_PROMPT_VERSION = "v2" as const;

// Keywords are the one unbounded field on the snapshot; a long tail of them buys
// no signal and is paid for on every screen.
const MAX_KEYWORDS = 20;

export const SCREEN_QUESTION =
  "Does this candidate belong to the target audience the client described?";

// The state Jev judges: the customer's own words, verbatim, and the candidate.
export function buildScreenState(
  targetAudience: string,
  teaser: TeaserSnapshot
): Record<string, unknown> {
  return { targetAudience, candidate: teaser };
}

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

export type ScreenOutcome =
  | { screened: true; onTarget: boolean; yesProbability: number }
  // Skipped for a stated reason — no target in the customer's words, or no
  // snapshot to judge. Both are honest absences, counted and logged, never a
  // quiet pass dressed up as a verdict.
  | { screened: false; skipReason: "no_target_text" | "no_snapshot" };

export interface ScreenSubject {
  providerPersonId: string;
  linkedinUrl: string | null;
  teaser: TeaserSnapshot | null;
}

// Judge one teaser and PERSIST the outcome. Returns the verdict so the caller
// can decide whether to pay for the reveal.
//
// Fail loud: a chat-service failure — or an answer without a yes-probability —
// throws (ChatServiceError / ChatConfigError) and serve-next surfaces it as
// 502. Passing the teaser through on a screening outage would spend the credit
// the screen exists to protect.
export async function screenTeaser(args: {
  orgId: string;
  audience: { id: string; nlPrompt: string | null; targetText: string | null };
  subject: ScreenSubject;
  identity: ChatIdentity;
}): Promise<ScreenOutcome> {
  const { orgId, audience, subject, identity } = args;

  // THIS audience's text, never the LLM-written `description` — that one can
  // describe how the Apollo filters were built, not who the customer wants.
  const target = screenTarget(audience);
  if (!target) {
    console.log(
      `[human-service] teaser_screen.skipped org=${orgId} audience=${audience.id} reason=no_target_text`
    );
    return { screened: false, skipReason: "no_target_text" };
  }
  if (!subject.teaser) {
    // Buffered before the screen shipped, so there is no snapshot to judge and
    // apollo's cursor has long moved past the page that held one.
    console.log(
      `[human-service] teaser_screen.skipped org=${orgId} audience=${audience.id} person=${subject.providerPersonId} reason=no_snapshot`
    );
    return { screened: false, skipReason: "no_snapshot" };
  }

  const judgment = await judgeYesNo({
    state: buildScreenState(target.text, subject.teaser),
    instructions: SCREEN_QUESTION,
    identity,
  });
  const onTarget = judgment.yesProbability > SCREEN_MIN_YES_PROBABILITY;

  await recordScreening({
    orgId,
    audienceId: audience.id,
    subject: { ...subject, teaser: subject.teaser },
    onTarget,
    yesProbability: judgment.yesProbability,
    model: `typesafe/${judgment.model}`,
    target,
  });

  return { screened: true, onTarget, yesProbability: judgment.yesProbability };
}

// Bronze row always; silver row too when the verdict is a rejection. ONE
// transaction, so a person can never sit in the exclusion set without the
// evidence that put them there.
async function recordScreening(args: {
  orgId: string;
  audienceId: string;
  subject: ScreenSubject & { teaser: TeaserSnapshot };
  onTarget: boolean;
  yesProbability: number;
  model: string;
  target: { text: string; field: "target_text" | "nl_prompt" };
}): Promise<void> {
  const { orgId, audienceId, subject, onTarget, yesProbability, model, target } = args;
  const reason = `P(yes)=${yesProbability.toFixed(3)} threshold>${SCREEN_MIN_YES_PROBABILITY}`;
  await db.transaction(async (tx) => {
    await tx.insert(audienceTeaserScreenings).values({
      orgId,
      audienceId,
      providerPersonId: subject.providerPersonId,
      linkedinUrl: subject.linkedinUrl,
      teaser: subject.teaser,
      verdict: onTarget,
      yesProbability,
      reason,
      model,
      promptVersion: SCREEN_PROMPT_VERSION,
      targetText: target.text,
      targetField: target.field,
    });
    if (onTarget) return;
    await tx
      .insert(audienceScreenedOut)
      .values({
        orgId,
        audienceId,
        providerPersonId: subject.providerPersonId,
        linkedinUrl: subject.linkedinUrl,
        reason,
      })
      // A person already excluded stays excluded at their original date — a
      // re-screen under a new prompt records its own bronze row and leaves the
      // silver one alone.
      .onConflictDoNothing({
        target: [
          audienceScreenedOut.audienceId,
          audienceScreenedOut.providerPersonId,
        ],
      });
  });
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
