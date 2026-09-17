// Pre-pay teaser screening — judge an apollo free teaser against the audience's
// own description BEFORE spending the credit that reveals its email.
//
// WHY THIS EXISTS. An apollo audience is a pointer to a faithful Apollo filter
// set, and Apollo's vocabulary cannot express every constraint an audience
// states in plain English: "chiropractors who own their practice", "German-
// speaking Switzerland", "shops that stock the product" have no field. So a
// teaser can satisfy every filter and still be the wrong person — and today we
// learn that only after the apollo credit, the generated email and the send are
// all spent on them.
//
// WHERE IT SITS. Exactly at the frontier between free and billed: serve-next
// pops a free teaser, we judge it, and only a pass reaches `resolveEmail`. One
// call per person, never a batch: a cheap model asked for a hundred verdicts
// keyed on a list index drifts, and a drifted verdict is worse than no screen
// (it rejects people who were fine and passes people who were not). One person,
// one boolean, is a task a cheap model does well.
//
// WHAT IT COSTS. At the model below, ~0.025 cents per screen against ~11.8
// cents for one apollo reveal — roughly 470 screens for the price of one
// reveal, so the screen pays for itself at a rejection rate above ~0.2%.
//
// LAYERING. Bronze `audience_teaser_screenings` records EVERY verdict (passes
// included) with the snapshot, model and prompt version behind it; silver
// `audience_screened_out` is the exclusion set the serve path reads. Both are
// written in ONE transaction, so a rejection can never exist without the
// evidence that produced it. Same shape as lead_serves -> brand_suppressions,
// one grain over — keyed on the AUDIENCE, because the verdict is relative to
// the target that audience defined.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  audienceScreenedOut,
  audienceTeaserScreenings,
  type TeaserSnapshot,
} from "../db/schema.js";
import { completeJson, type ChatIdentity } from "../lib/chat-client.js";
import type { Person } from "./people-providers.js";

// Cheapest model reachable through chat-service /complete: GLM-5.3-Flash lists
// at $0.15/$0.50 per 1M tokens against Gemini 3.5 Flash-Lite's $0.30/$2.50 and
// DeepSeek V4.1 Flash's $0.15/$0.60-at-off-peak (doubling at peak). It is also
// the slowest of the three (p50 4.2s against flash-lite's 2.1s, measured over 30
// days of chat-service /complete runs) — accepted deliberately: the screen sits
// on a path that already waits on an apollo enrich, and the consumer buffers.
//
// zai takes `response_format: {type:"json_schema"}` (chat-service probed it
// live), and glm-5.3-flash already carries `reasoning_effort: "low"` in
// chat-service's per-model config, so its reasoning is silent — nothing to
// disable from here, and no thinking tokens to pay for.
export const SCREEN_LLM_PROVIDER = "zai" as const;
export const SCREEN_LLM_MODEL = "glm-flash" as const;

// Bump when the prompt changes. Stored on every bronze row so a later verdict
// can be read against the prompt that produced it rather than the current one.
export const SCREEN_PROMPT_VERSION = "v1" as const;

// Keywords are the one unbounded field on the snapshot; a long tail of them buys
// no signal and is paid for on every screen.
const MAX_KEYWORDS = 20;

const SCREEN_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    // `onTarget` before `why`: the model commits to the verdict, then justifies
    // it. Asking for the sentence first invites it to write its way into an
    // answer.
    onTarget: {
      type: "boolean",
      description: "true if this person belongs to the target audience.",
    },
    why: {
      type: "string",
      description: "One short sentence justifying the verdict.",
    },
  },
  required: ["onTarget", "why"],
  additionalProperties: false,
} as const;

export function buildScreenSystemPrompt(): string {
  return [
    "You decide whether ONE person belongs to a target audience.",
    "",
    "You are given the audience the client asked for, in their own words, and one",
    "candidate as a cold-email database returned them. Answer whether this",
    "candidate is a person the client meant.",
    "",
    "Judge the person, not the record. The candidate comes from a free preview:",
    "the last name, the email and often the location are withheld, and many",
    "fields are simply empty. A field you cannot see is unknown, never a reason",
    "to reject — reject only on something the record actually says.",
    "",
    "Say no when the record contradicts the audience: the wrong occupation, the",
    "wrong kind of employer, the wrong seniority, the wrong country when the",
    "audience named one. Say yes when the record is consistent with it, including",
    "when it is thin.",
    "",
    "Borderline cases are a yes. This audience feeds a cold-email campaign, so a",
    "somewhat-imprecise recipient costs one email while a wrongly-rejected one",
    "costs a prospect the client wanted and paid to find.",
    "",
    'Answer with {"onTarget": boolean, "why": one short sentence}.',
  ].join("\n");
}

export function buildScreenMessage(
  target: { name: string; description: string },
  teaser: TeaserSnapshot
): string {
  return [
    "TARGET AUDIENCE",
    `Name: ${target.name}`,
    `Described as: ${target.description}`,
    "",
    "CANDIDATE",
    JSON.stringify(teaser, null, 2),
  ].join("\n");
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
  | { screened: true; onTarget: boolean; why: string }
  // Skipped for a stated reason — no target to judge against, or no snapshot to
  // judge. Both are honest absences, counted and logged, never a quiet pass
  // dressed up as a verdict.
  | { screened: false; skipReason: "no_description" | "no_snapshot" };

export interface ScreenSubject {
  providerPersonId: string;
  linkedinUrl: string | null;
  teaser: TeaserSnapshot | null;
}

// Judge one teaser and PERSIST the outcome. Returns the verdict so the caller
// can decide whether to pay for the reveal.
//
// Fail loud: a chat-service failure throws (ChatServiceError / ChatConfigError)
// and serve-next surfaces it as 502. Passing the teaser through on a screening
// outage would spend the credit the screen exists to protect, which is the
// failure this feature is about.
export async function screenTeaser(args: {
  orgId: string;
  audience: { id: string; name: string; description: string | null };
  subject: ScreenSubject;
  identity: ChatIdentity;
}): Promise<ScreenOutcome> {
  const { orgId, audience, subject, identity } = args;

  if (!audience.description) {
    console.log(
      `[human-service] teaser_screen.skipped org=${orgId} audience=${audience.id} reason=no_description`
    );
    return { screened: false, skipReason: "no_description" };
  }
  if (!subject.teaser) {
    // Buffered before the screen shipped, so there is no snapshot to judge and
    // apollo's cursor has long moved past the page that held one.
    console.log(
      `[human-service] teaser_screen.skipped org=${orgId} audience=${audience.id} person=${subject.providerPersonId} reason=no_snapshot`
    );
    return { screened: false, skipReason: "no_snapshot" };
  }

  const json = await completeJson({
    systemPrompt: buildScreenSystemPrompt(),
    message: buildScreenMessage(
      { name: audience.name, description: audience.description },
      subject.teaser
    ),
    responseSchema: SCREEN_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    provider: SCREEN_LLM_PROVIDER,
    model: SCREEN_LLM_MODEL,
    identity,
  });

  const onTarget = json.onTarget;
  if (typeof onTarget !== "boolean") {
    // The one field the whole call exists to produce. Anything else is not a
    // verdict, and inventing one here would be the silent pass we are avoiding.
    throw new Error(
      `[human-service] teaser_screen returned no boolean onTarget (got ${JSON.stringify(json.onTarget)})`
    );
  }
  const why = typeof json.why === "string" ? json.why : "";

  await recordScreening({
    orgId,
    audienceId: audience.id,
    subject: { ...subject, teaser: subject.teaser },
    onTarget,
    why,
  });

  return { screened: true, onTarget, why };
}

// Bronze row always; silver row too when the verdict is a rejection. ONE
// transaction, so a person can never sit in the exclusion set without the
// evidence that put them there.
async function recordScreening(args: {
  orgId: string;
  audienceId: string;
  subject: ScreenSubject & { teaser: TeaserSnapshot };
  onTarget: boolean;
  why: string;
}): Promise<void> {
  const { orgId, audienceId, subject, onTarget, why } = args;
  await db.transaction(async (tx) => {
    await tx.insert(audienceTeaserScreenings).values({
      orgId,
      audienceId,
      providerPersonId: subject.providerPersonId,
      linkedinUrl: subject.linkedinUrl,
      teaser: subject.teaser,
      verdict: onTarget,
      reason: why,
      model: `${SCREEN_LLM_PROVIDER}/${SCREEN_LLM_MODEL}`,
      promptVersion: SCREEN_PROMPT_VERSION,
    });
    if (onTarget) return;
    await tx
      .insert(audienceScreenedOut)
      .values({
        orgId,
        audienceId,
        providerPersonId: subject.providerPersonId,
        linkedinUrl: subject.linkedinUrl,
        reason: why,
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
