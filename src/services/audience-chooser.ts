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
 * IT ACCOUNTS FOR EVERY ATTEMPT, AFTER CHOOSING. The answer carries one
 * sentence per attempt, including the ones it passed over, and the whole
 * decision is persisted on the chosen audience row (`audiences.chooser_trace`)
 * so it can be READ instead of inferred from the outcome — inference from
 * outcome is what was done four times over for the three apollo-side mechanisms
 * that degenerated. Requiring a sentence for a rejection is also a guardrail in
 * its own right: writing "I passed over the 2,078-person set because..." is hard
 * when the real reason is "I did not look at it". The sentences are prose for a
 * human; they are never a score, never a ranking, and nothing reads them back.
 * The ORDER matters — the pick is committed before any of them is written,
 * because a per-attempt grade asked first is exactly the degenerate shape.
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
// reasoning, not extraction — so the strongest model available, with reasoning
// left ON (layer 1 and the description generator disable it because they are
// narrow structured tasks; this one is not).
//
// OpenAI GPT-6 Astra rather than Gemini 3.1 Pro: the onboarding audience step is
// a ~100s wait a user sits through, and the chooser is a measured slice of it —
// p50 12.3s / p90 19.7s on google/pro against p50 6.6s / p90 9.9s on this call's
// own path on Astra. Astra REJECTS `temperature` and `top_p` with a 400, so this
// call sends NEITHER (it never did) and must never start; `disableThinking` is
// likewise not sent, which leaves Astra at its default reasoning level rather
// than its low floor. Everything else — prompt, response schema, retries,
// tracking — is unchanged.
const CHOOSER_LLM_PROVIDER = "openai" as const;
const CHOOSER_LLM_MODEL = "gpt-pro";

// The ORDER of these keys is load-bearing, not cosmetic. `chosen` comes first
// and `rationales` after it, because the model writes the JSON in order: it must
// commit to a pick BEFORE it writes a sentence about any individual attempt.
// Asking "is this attempt good?" per item, in isolation, ahead of the choice is
// exactly the shape that degenerated to a constant three times upstream
// (reachesOffTarget always clean, matchesRequest always true, showable true on
// 60 of 60). `propertyOrdering` is Gemini's own knob for this.
const CHOOSER_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    chosen: { type: "integer" },
    why: { type: "string" },
    rationales: {
      type: "array",
      items: {
        type: "object",
        properties: {
          attempt: { type: "integer" },
          rationale: { type: "string" },
        },
        required: ["attempt", "rationale"],
        propertyOrdering: ["attempt", "rationale"],
      },
    },
    name: { type: "string" },
    description: { type: "string" },
    degraded: { type: "boolean" },
    degradedReason: { type: "string" },
  },
  required: [
    "chosen",
    "why",
    "rationales",
    "name",
    "description",
    "degraded",
    "degradedReason",
  ],
  propertyOrdering: [
    "chosen",
    "why",
    "rationales",
    "name",
    "description",
    "degraded",
    "degradedReason",
  ],
};

export interface ChosenAudience {
  candidate: ApolloCandidate;
  /** 1-based, as the model named it — echoed for the log line. */
  chosen: number;
  /** The model's one-sentence account of why this one beat the others. */
  why: string;
  /**
   * One sentence per attempt, 1-based by position, INCLUDING the ones it did
   * not take. Prose for a human reading the trace back — never a score, never
   * a ranking, never an input to the selection, which has already happened by
   * the time these are written.
   */
  rationales: string[];
  /** The model's own account of the `degraded` verdict. Empty when it has none. */
  degradedReason: string;
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
    "WHAT EACH ATTEMPT COST IN VOLUME. The table lists, per attempt, how many",
    "people it matched and which filter fields it used. Every field an attempt",
    "adds intersects: it can only remove people, never add any. So two attempts",
    "that differ by a field or two, at very different volumes, are showing you",
    "what that constraint took out. This is INFORMATION, not a rule: no field is",
    "good or bad in itself, more fields is neither better nor worse, and the",
    "sample rows still decide. It is here so that an attempt reaching a fifth as",
    "many people as its neighbour is legible as a choice you are making, rather",
    "than something you pass over without seeing.",
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
    "decides what to do with it -- it never means you return nothing. In",
    '"degradedReason", say in one sentence what the client asked for that no',
    "attempt delivered; leave it empty when degraded is false.",
    "",
    "THEN, HAVING PICKED, ACCOUNT FOR EVERY ATTEMPT. Write one sentence per",
    "attempt in the order they are listed, including the ones you did not take:",
    "what that attempt reaches, and what made you pass over it. A human reads",
    "these back later to see whether a bigger attempt was weighed and rejected or",
    'simply never looked at, so "not chosen" is not a sentence: name what is in',
    "that attempt's sample or filters that decided it. Do this AFTER you have",
    "named your pick, never before -- judging attempts one at a time in isolation",
    "is not how this decision is made.",
    "",
    "Respond with ONLY valid JSON (no prose, no markdown), keys in this order:",
    '{"chosen":<attempt number>,"why":"one sentence on why it beat the others",',
    '"rationales":[{"attempt":1,"rationale":"one sentence"},...one per attempt],',
    '"name":"<=4 words","description":"one sentence","degraded":<true|false>,',
    '"degradedReason":"one sentence, or empty"}',
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

/**
 * The filter FIELDS an attempt used, in the order apollo-service sent them.
 * Purely descriptive: a field name is a name, and an empty / null-valued field
 * is not a constraint, so it is not listed. Exported because the persisted
 * chooser trace records the same list the chooser was shown.
 */
export function filterFieldNames(filters: Record<string, unknown>): string[] {
  return Object.entries(filters)
    .filter(([, v]) => {
      if (v === null || v === undefined) return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "string") return v.trim().length > 0;
      return true;
    })
    .map(([k]) => k);
}

/**
 * A side-by-side table of every attempt: volume next to the filter fields that
 * produced it. The per-attempt blocks below already carry both, but scattered
 * across hundreds of lines — an attempt at a fifth of its neighbour's volume
 * carrying two more fields is only legible when the two sit on adjacent rows.
 *
 * It ranks nothing and sorts nothing: attempts stay in the order they were
 * explored, and no column is a verdict. Presenting the trade is not making it.
 */
function renderAtAGlance(candidates: ApolloCandidate[]): string[] {
  return [
    "AT A GLANCE (same attempts, listed in the order they were explored):",
    "  attempt | people matched | filter fields used",
    ...candidates.map((c, i) => {
      const fields = filterFieldNames(c.filters);
      return `  ${i + 1} | ${c.count} | ${fields.length}: ${fields.join(", ") || "none"}`;
    }),
  ];
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
    ...renderAtAGlance(args.candidates),
    "",
    `THE ${args.candidates.length} ATTEMPTS:`,
  ];
  args.candidates.forEach((c, i) => {
    const fields = filterFieldNames(c.filters);
    lines.push(
      "",
      `ATTEMPT ${i + 1}`,
      `  people matched: ${c.count}`,
      `  filter fields used (${fields.length}): ${fields.join(", ") || "none"}`,
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
  const rationales = parseRationales(json.rationales, args.candidates.length);
  const degradedReason =
    typeof json.degradedReason === "string" ? json.degradedReason.trim() : "";

  return {
    candidate: args.candidates[chosen - 1],
    chosen,
    why,
    rationales,
    name,
    description,
    // Only an explicit `true` degrades — a missing field is not a verdict.
    degraded: json.degraded === true,
    degradedReason,
  };
}

/**
 * One sentence per attempt, by 1-based position, all of them present.
 *
 * FULL COVERAGE IS THE POINT, so a gap fails loud rather than being padded.
 * Requiring a sentence for the attempts it did NOT take is the guardrail:
 * writing "I passed over the 2,078-person set because..." is hard when the real
 * reason is "I never looked at it". A trace with holes cannot answer the
 * question it exists to answer, and a placeholder we wrote ourselves would
 * answer it falsely — which is the failure mode this whole decision replaced.
 */
function parseRationales(raw: unknown, expected: number): string[] {
  if (!Array.isArray(raw)) {
    throw new ChatServiceError(
      502,
      "chooser returned no `rationales` array; one sentence per attempt is required"
    );
  }
  const byAttempt = new Map<number, string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const attempt = o.attempt;
    const rationale = typeof o.rationale === "string" ? o.rationale.trim() : "";
    if (
      typeof attempt === "number" &&
      Number.isInteger(attempt) &&
      attempt >= 1 &&
      attempt <= expected &&
      rationale.length > 0 &&
      !byAttempt.has(attempt)
    ) {
      byAttempt.set(attempt, rationale);
    }
  }
  const missing: number[] = [];
  const out: string[] = [];
  for (let i = 1; i <= expected; i += 1) {
    const r = byAttempt.get(i);
    if (r === undefined) missing.push(i);
    out.push(r ?? "");
  }
  if (missing.length > 0) {
    throw new ChatServiceError(
      502,
      `chooser gave no rationale for attempt(s) ${missing.join(", ")} of ${expected}; every attempt must be accounted for`
    );
  }
  return out;
}

// How many sample rows of a candidate the trace keeps. The chooser is shown ten
// per attempt; the trace keeps a REDUCED sample because its job is to let a
// human recognise WHO an attempt reached ("Mars, Lidl, Bucherer" vs "Abderhalden
// Drogerie AG"), which the first few rows already answer, and because ten
// candidates x ten rows on every audience row is a snapshot nobody reads.
const TRACE_SAMPLE_ROWS = 5;

/** Trace format version, so a later reader can tell shapes apart. */
export const CHOOSER_TRACE_VERSION = 1;

/**
 * The persisted, human-readable record of the decision.
 *
 * Everything here is prose or evidence: the rationales are sentences for a human
 * reading the row back, NOT a score, NOT a ranking, and nothing in this service
 * reads them. The choice was made before any of them was written.
 */
export function buildChooserTrace(args: {
  nlPrompt: string;
  candidates: ApolloCandidate[];
  chosen: ChosenAudience;
}): Record<string, unknown> {
  return {
    version: CHOOSER_TRACE_VERSION,
    nlPrompt: args.nlPrompt,
    chosen: args.chosen.chosen,
    why: args.chosen.why,
    degraded: args.chosen.degraded,
    // Empty string is not a reason — record its absence honestly.
    degradedReason: args.chosen.degradedReason || null,
    candidates: args.candidates.map((c, i) => ({
      attempt: i + 1,
      apolloAudienceId: c.apolloAudienceId,
      count: c.count,
      filters: c.filters,
      filterFields: filterFieldNames(c.filters),
      sample: c.sample.slice(0, TRACE_SAMPLE_ROWS),
      chosen: i + 1 === args.chosen.chosen,
      rationale: args.chosen.rationales[i] ?? null,
    })),
  };
}
