// Audience TARGET — the sentence the pre-pay screen (teaser-screening.ts) judges
// every candidate against, stored as `audiences.nl_prompt`.
//
// WHY THIS EXISTS. A customer usually answers "who do you sell to?" with a kind
// of COMPANY ("crypto market making firms"). The screen then asks "does this
// person belong to the target?", and an HR manager, an employer-branding
// specialist or a compliance officer at a crypto market maker DOES belong to
// "crypto market making firms" — so they passed and were emailed about a Solana
// derivatives exchange (Olive, 2026-09-29; the client paused the campaign).
// Adding "decision makers only" did not fix it either: a Head of HR is a
// decision maker, just not for this product.
//
// So before an audience is stored, its target is restated as PEOPLE: the roles
// whose job makes them decide on or care about what the client sells, the
// people around them (assistants, chiefs of staff, advisors, coaches, the
// managers of those teams), and the functions with no stake in the purchase,
// named as out. Both directions matter: stop emailing the wrong people, and do
// not reject the ones who should be kept.
//
// The roles are DERIVED BY THE MODEL from what the client sells (the offer's own
// description, read from brand-service) — there is no role list here, because
// the roles differ per product. Nothing about the companies changes: the
// restatement keeps every constraint the customer stated and adds none.
//
// The Apollo filters are deliberately NOT narrowed to these roles. The people
// around a decision maker (an executive assistant, a chief of staff) carry no
// title or seniority a people filter can tie to the buyer, so a title filter
// would drop exactly the people this rule says to keep. The pool stays the
// companies the customer named; the screen picks the people inside it.
//
// Cost: one chat-service /complete, owned and billed by chat-service with the
// caller's identity. human-service declares none.

import { listBrandOffers, type BrandOffer } from "../lib/brand-offers.js";
import {
  ChatServiceError,
  completeJson,
  type ChatIdentity,
} from "../lib/chat-client.js";
import { completeRun, createRun } from "./runs.js";

// Same switch as every other onboarding audience call (owner decision
// 2026-09-29): Claude Sonnet 5.5, which rejects temperature, so no sampling
// param is sent; `disableThinking` = chat-service's lowest effort.
const TARGET_LLM_PROVIDER = "anthropic" as const;
const TARGET_LLM_MODEL = "sonnet";

const TARGET_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { target: { type: "string" } },
  required: ["target"],
};

/** Exported for the unit test that pins the target's invariants. */
export function buildTargetSystemPrompt(): string {
  return [
    "A company runs cold email campaigns. It told you who it sells to, and you",
    "know what it sells. Write the TARGET: the description a reviewer will use to",
    "decide, one person at a time, whether that person is worth an email about",
    "what this company sells.",
    "",
    "THE TARGET NAMES PEOPLE, NOT ONLY COMPANIES. Everyone who works at the right",
    "company is not the right person. A person is in the target when their JOB",
    "makes them decide on, buy, use or care about what this company sells.",
    "",
    "Write it in three parts:",
    "  1. The people whose job makes them decide on or care about what this",
    "     company sells, at the companies the customer named. Derive those roles",
    "     from what is sold: think about who, inside such a company, would choose,",
    "     pay for, use or champion it. Name them in words a reader recognises",
    "     on a profile.",
    "  2. The people around them, who are ALSO in the target: the people who",
    "     assist or advise them on this (their executive assistants, chiefs of",
    "     staff, advisors, coaches) and the managers of the teams that do this",
    "     work. Being close to that decision is enough to be in.",
    "  3. The functions at those companies that have no stake in this purchase,",
    "     named as OUT. Seniority alone never puts someone in: the head of a",
    "     function with no stake in this purchase is out, however senior.",
    "",
    "RESTATE, NEVER REDEFINE THE COMPANIES:",
    "  - Keep every constraint the customer stated (kind of company, sector,",
    "    geography, size) and add none. Do not add kinds of companies, places or",
    "    sizes the customer did not name, and do not drop any they did.",
    "  - If the customer already named the people (roles, titles, seniority),",
    "    keep exactly those people as part 1 and add their entourage (part 2)",
    "    and the out functions (part 3). Do not add other buyer roles.",
    "",
    "FORM:",
    "  - Plain English, one to three sentences, no bullet points, no em dashes.",
    "  - Positive and specific: name the roles, never \"relevant people\" or",
    "    \"the right stakeholders\".",
    "  - Say nothing about how many people this is. Write no search-tool field",
    "    names.",
    "",
    'Respond with ONLY valid JSON: {"target":"<the target>"}',
  ].join("\n");
}

/** Exported for the unit test. What the company sells, as the model reads it. */
export function describeWhatIsSold(offers: BrandOffer[]): string {
  return offers
    .map((o) => (o.description ? `- ${o.name}: ${o.description}` : `- ${o.name}`))
    .join("\n");
}

export function buildTargetMessage(customerTarget: string, offers: BrandOffer[]): string {
  return [
    "WHO THE CUSTOMER SAYS IT SELLS TO:",
    customerTarget,
    "",
    "WHAT THE COMPANY SELLS:",
    describeWhatIsSold(offers),
  ].join("\n");
}

export class AudienceTargetOfferNotFoundError extends Error {
  constructor(
    public readonly brandId: string,
    public readonly offerId: string
  ) {
    super(
      `Offer ${offerId} is not an offer of brand ${brandId} for this org, so what it sells is unknown and the audience target cannot be written.`
    );
    this.name = "AudienceTargetOfferNotFoundError";
  }
}

/**
 * Restate the customer's words as a person-level target, using what the client
 * sells. `offerId` given ⟹ THAT offer (unknown ⟹ AudienceTargetOfferNotFoundError);
 * omitted ⟹ every offer of the brand (a brand-wide audience serves them all).
 *
 * Returns `null` ONLY when the brand holds no offer at all: nothing says what it
 * sells, so no role can be derived, and the customer's words are kept as they
 * are (logged loudly by the caller). Any chat-service / brand-service failure
 * propagates (fail loud, 502 at the route).
 */
export async function draftAudienceTarget(args: {
  customerTarget: string;
  brandId: string;
  offerId: string | null;
  identity: ChatIdentity;
}): Promise<string | null> {
  const all = await listBrandOffers(args.brandId, args.identity.orgId);
  let offers = all;
  if (args.offerId) {
    offers = all.filter((o) => o.offerId === args.offerId);
    if (offers.length === 0) {
      throw new AudienceTargetOfferNotFoundError(args.brandId, args.offerId);
    }
  }
  if (offers.length === 0) return null;

  const message = buildTargetMessage(args.customerTarget, offers);
  // chat-service REQUIRES x-run-id, and a split confirm often arrives without
  // one (the pointer build handles the same gap the same way): open our OWN run
  // under the caller's org, so the call is still org-billed and traced. No run
  // ⟹ fail loud, never an unattributed LLM call.
  if (args.identity.runId) return writeTarget(message, args.identity);
  if (!args.identity.userId) {
    throw new ChatServiceError(
      502,
      "no x-run-id and no user to open a run for the audience target draft"
    );
  }
  const tracking = { ...(args.identity.workflowTracking ?? {}), brandIds: [args.brandId] };
  const runId = await createRun({
    orgId: args.identity.orgId,
    userId: args.identity.userId,
    taskName: "audience-target-draft",
    workflowTracking: tracking,
  });
  if (!runId) {
    throw new ChatServiceError(502, "runs-service did not open a run for the audience target draft");
  }
  const runIdentity = { orgId: args.identity.orgId, userId: args.identity.userId, workflowTracking: tracking };
  try {
    const target = await writeTarget(message, { ...args.identity, runId, workflowTracking: tracking });
    await completeRun(runId, "completed", runIdentity);
    return target;
  } catch (err) {
    await completeRun(runId, "failed", runIdentity);
    throw err;
  }
}

async function writeTarget(message: string, identity: ChatIdentity): Promise<string> {
  const out = await completeJson({
    message,
    systemPrompt: buildTargetSystemPrompt(),
    identity,
    provider: TARGET_LLM_PROVIDER,
    model: TARGET_LLM_MODEL,
    responseSchema: TARGET_RESPONSE_SCHEMA,
    disableThinking: true,
  });
  const target = typeof out.target === "string" ? out.target.trim() : "";
  if (!target) {
    throw new ChatServiceError(502, "LLM returned no audience target");
  }
  return target;
}
