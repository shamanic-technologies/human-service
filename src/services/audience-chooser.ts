/**
 * The chooser: ONE LLM call that picks the audience a customer gets, and writes
 * the name + description stored for it.
 *
 * WHY IT LIVES HERE. apollo-service explores — up to ten rounds, each proposing
 * a filter set, dry-running it for a free live count, and seeing a sample of who
 * it matched. For weeks it also DECIDED which round won, and every mechanism for
 * deciding failed the same way: a model grading its own proposal in isolation
 * answers the same way every time. `reachesOffTarget`/`leavesTargetUnreached`
 * came back clean on everything; `matchesRequest` came back true on World Health
 * Organization and HORNBACH Baumarkt; `showable` came back true on 60 of 60
 * rounds, so selection collapsed to plain argmax-count and one production run
 * returned 179,156 people at Mars, Lidl, Bucherer and Manor. The exploration was
 * never the problem — nearly every run contains a round in the low hundreds to
 * ~2,000 with recognisable Swiss drugstores. The model writes the right filter
 * set and cannot pick it.
 *
 * So the decision moved here. human-service owns the audience concept and talks
 * to the customer, so "which of these serves this customer" is a product
 * decision that belongs in this repo — and a chooser that did not author the
 * sets has no stake in any of them. Choosing among N is COMPARATIVE, which is
 * precisely what does not degenerate the way an absolute self-grade does.
 *
 * ONE CALL DOES BOTH, and that is the point rather than a shortcut. The audience
 * used to be relabelled from its final filters by a SECOND call
 * (`generateAudienceDescription`); splitting choice and description across two
 * calls lets them disagree about what the audience is. Merging them means the
 * thing that picks is the thing that describes, so they cannot.
 *
 * NOTHING HERE SELECTS IN CODE. No argmax on count, no scoring function, no
 * ranking, no tie-break heuristic, no count floor, no target band. The model is
 * handed every candidate with its count AND its sample rows AND its notes, and
 * it names the one it picks. Code only validates that the index it returned
 * exists.
 *
 * The LLM runs via chat-service `POST /complete`, which OWNS the cost
 * (provision→authorize→execute→actualize against the org balance) — human-
 * service declares none, exactly as for layer 1 and the avatar. Fail loud: a
 * chat-service non-2xx throws ChatServiceError → 502 at the route; an answer
 * that does not name a real candidate throws too. There is no fallback: a
 * chooser that quietly picked for itself would be the failure being removed.
 */

import { completeJson, ChatServiceError } from "../lib/chat-client.js";
import type { ApolloCandidate } from "../lib/apollo-audiences.js";
import type { Identity } from "./people-providers.js";

// A comparative judgement over ten candidates x ten sample rows is real
// reasoning, not extraction — so the strongest Gemini, with thinking left ON
// (layer 1 and the description generator disable it because they are narrow
// structured tasks; this one is not).
const CHOOSER_LLM_PROVIDER = "google" as const;
const CHOOSER_LLM_MODEL = "pro";

const CHOOSER_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    chosen: { type: "integer" },
    why: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    degraded: { type: "boolean" },
  },
  required: ["chosen", "why", "name", "description", "degraded"],
};

export interface ChosenAudience {
  candidate: ApolloCandidate;
  /** 1-based, as the model named it — echoed for the log line. */
  chosen: number;
  /** The model's one-sentence account of why this one beat the others. */
  why: string;
  /** Stored as the audience name (max 4 words is asked of the model). */
  name: string;
  /** Stored as the audience description — the label for the CHOSEN set. */
  description: string;
  /** The chooser's verdict: no candidate really answers the request. */
  degraded: boolean;
}

/** Exported for the unit test that guards the chooser's invariants (comparative
 * pick, samples decide, the volume context is present AND is not a floor, always
 * pick one, name + description written here). */
export function buildChooserSystemPrompt(): string {
  return [
    "A search expert explored a people-search database for a client's audience",
    "request. Each attempt below is a real filter set it ran: a live count of how",
    "many people matched, ten of the people it actually matched, and the expert's",
    "own notes on that attempt.",
    "",
    "YOU PICK EXACTLY ONE of them, and you write the name and the description the",
    "client will see on it. You always pick one. There is no option to refuse, to",
    "ask for another attempt, or to return nothing.",
    "",
    "WHAT DECIDES: WHO IS IN THE SET. Read the sample rows before anything else.",
    "They are the only evidence of who a filter set actually reaches, and they are",
    "why this decision is worth making at all:",
    "a count tells you how many people a set holds, never whether they are the client's people.",
    "A large attempt whose",
    "sample is full of companies that are plainly not what the client asked for is",
    "a WORSE answer than a small attempt whose sample is recognisably the target.",
    "Compare the attempts against each other on that basis and say which one wins.",
    "",
    "The expert's notes are its commentary on its own attempt -- useful context",
    "for what it was trying, never a verdict on whether it succeeded. The filter",
    "set is shown so you can describe honestly what the chosen attempt encodes.",
    "",
    "WHY VOLUME MATTERS. The audience feeds a COLD EMAIL campaign, so a somewhat-",
    "too-large audience carrying some noise beats a too-narrow one: a campaign",
    "needs people to send to, and a few off-target recipients cost far less than",
    "an audience that runs dry. An engagement is hard to justify below roughly",
    "2,000 contactable people; a durably successful client is more like 50,000.",
    "",
    "THOSE NUMBERS EXPLAIN WHY VOLUME MATTERS. THEY ARE NOT A FLOOR TO REACH.",
    "Some markets are genuinely small. A client's entire addressable market can be",
    "a few hundred people -- independent Swiss drugstores are two-to-five-person",
    "shops, and no database indexes them in the thousands. A GENUINELY SMALL",
    "MARKET IS A VALID, CORRECT ANSWER. Never pick an attempt full of the wrong",
    "companies because its count is closer to 2,000: an attempt that reached that",
    "number by drifting into manufacturers, retail chains and multinationals did",
    "not find more of the client's people, it found other people.",
    "",
    "THE NAME AND THE DESCRIPTION DESCRIBE THE ATTEMPT YOU CHOSE -- not the",
    "client's original wording, and not what you wish the attempt had matched.",
    "Derive both from the chosen attempt's own filters and sample, and",
    "never promise a constraint the chosen set does not encode.",
    '- "name": a short human label, MAX 4 words (e.g. "Swiss Drugstore Owners").',
    '- "description": ONE self-contained present-tense sentence, at most 30 words,',
    "  pinning down who the chosen set contains -- the role/seniority and the",
    "  company type, sector and geography its filters encode. No preamble, no",
    "  trailing notes, no raw JSON. If the filters are sparse, say honestly what",
    "  little they encode.",
    "",
    'ALSO ANSWER "degraded": true when NO attempt really answers the client\'s',
    "request and you are picking the least-bad one anyway; false when the attempt",
    "you picked genuinely answers it. This is information for the client, who",
    "decides what to do with it -- it never means you return nothing.",
    "",
    "Respond with ONLY valid JSON (no prose, no markdown):",
    '{"chosen":<attempt number>,"why":"one sentence on why it beat the others",',
    '"name":"<=4 words","description":"one sentence","degraded":<true|false>}',
  ].join("\n");
}

function renderSample(candidate: ApolloCandidate): string[] {
  if (candidate.sample.length === 0) {
    // Honest absence, never a fabricated row: an older apollo-service deploy
    // sends no sample, and the chooser must know it is judging without one.
    return ["  people it matched: none supplied for this attempt"];
  }
  return [
    "  people it matched:",
    ...candidate.sample.map(
      (p) => `    - ${p.company ?? "unknown company"} — ${p.title ?? "unknown title"}`
    ),
  ];
}

function renderNotes(candidate: ApolloCandidate): string[] {
  const n = candidate.notes;
  if (!n) return [];
  const lines: string[] = ["  the expert's notes on this attempt:"];
  if (n.whatWorked) lines.push(`    what worked: ${n.whatWorked}`);
  if (n.whatToImprove) lines.push(`    what to improve: ${n.whatToImprove}`);
  if (n.nextExperiment) lines.push(`    what it tried next, and why: ${n.nextExperiment}`);
  return lines;
}

/** Every candidate is rendered, always — hiding some to "simplify" the prompt
 * would take the comparison away from the only step that can make it. */
export function buildChooserMessage(args: {
  nlPrompt: string;
  candidates: ApolloCandidate[];
}): string {
  const lines: string[] = [
    "THE CLIENT'S REQUEST, VERBATIM:",
    args.nlPrompt,
    "",
    `THE ${args.candidates.length} ATTEMPTS:`,
  ];
  args.candidates.forEach((c, i) => {
    lines.push(
      "",
      `ATTEMPT ${i + 1}`,
      `  people matched: ${c.count}`,
      ...renderSample(c),
      ...renderNotes(c),
      `  filters it ran: ${JSON.stringify(c.filters)}`
    );
  });
  return lines.join("\n");
}

/**
 * Pick the audience, and write what it is called and what it says.
 *
 * `candidates` must be non-empty (`suggestApolloAudience` guarantees it: an
 * apollo-service deploy that sends no `candidates` array yields one synthesised
 * from its legacy single result). Throws ChatServiceError on an answer that
 * names no real attempt or omits the label — never falls back to picking here.
 */
export async function chooseAudienceCandidate(args: {
  nlPrompt: string;
  candidates: ApolloCandidate[];
  identity: Identity;
}): Promise<ChosenAudience> {
  if (args.candidates.length === 0) {
    throw new ChatServiceError(502, "no candidate audiences to choose from");
  }

  const json = await completeJson({
    message: buildChooserMessage({
      nlPrompt: args.nlPrompt,
      candidates: args.candidates,
    }),
    systemPrompt: buildChooserSystemPrompt(),
    identity: args.identity,
    provider: CHOOSER_LLM_PROVIDER,
    model: CHOOSER_LLM_MODEL,
    responseSchema: CHOOSER_RESPONSE_SCHEMA,
  });

  const chosen = json.chosen;
  if (
    typeof chosen !== "number" ||
    !Number.isInteger(chosen) ||
    chosen < 1 ||
    chosen > args.candidates.length
  ) {
    throw new ChatServiceError(
      502,
      `chooser named attempt ${JSON.stringify(chosen)}, which is not one of the ${args.candidates.length} offered`
    );
  }
  const name = typeof json.name === "string" ? json.name.trim() : "";
  if (name.length === 0) {
    throw new ChatServiceError(502, "chooser returned no `name` for the audience it picked");
  }
  const description =
    typeof json.description === "string" ? json.description.trim() : "";
  if (description.length === 0) {
    throw new ChatServiceError(
      502,
      "chooser returned no `description` for the audience it picked"
    );
  }
  const why = typeof json.why === "string" ? json.why.trim() : "";

  return {
    candidate: args.candidates[chosen - 1],
    chosen,
    why,
    name,
    description,
    // Only an explicit `true` degrades — a missing field is not a verdict.
    degraded: json.degraded === true,
  };
}
