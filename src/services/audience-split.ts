// Audience SPLIT — the light, conceptual version of shamanic-technologies/
// human-service#235. A customer states who they sell to; this proposes at most
// SIX non-overlapping segments of that target, in plain language, so a new
// campaign can A/B test them. On confirmation the chosen segments become the
// brand's ACTIVE audiences under the offer.
//
// What this deliberately does NOT do (and why it is fast):
//   - no Apollo call, no count, no volume estimate, no filter-refinement loop.
//     ONE writing call (chat-service /complete) splits the text; ONE typed
//     judgment call (chat-service /orgs/judgments, Jev) picks each card's icon
//     from a closed vocabulary.
//   - proposing persists NOTHING. Confirming writes one audiences row per chosen
//     segment, provider `apollo` with NO pointer and NO filters: turning the
//     description into faithful Apollo filters is the existing pointer build
//     (`backfillApolloAudiencePointer`). The confirm route fires it in the
//     background for every created row, and serve-next runs it inline if it has
//     not landed (`ensureApolloPointer`), so an active split audience is never
//     unservable. Nothing here re-implements it.
//
// "Findable later" is a FORM constraint on the split, not a search: the prompt
// only allows the axes Apollo can filter on (geography, company headcount,
// industry, seniority/role), one axis or two crossed, never overlapping mixes,
// so each segment maps to a filter set and an A/B result means something.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences } from "../db/schema.js";
import {
  ChatServiceError,
  completeJson,
  judgeChoices,
  type ChatIdentity,
} from "../lib/chat-client.js";
import {
  SPLIT_AXES,
  SPLIT_ICONS,
  type SplitAxis,
} from "../lib/audience-split-vocab.js";

export { SPLIT_AXES, SPLIT_ICONS, type SplitAxis };

// Same model + switch as /suggest's layer 1: a user waits on this inside the
// new-org modal. Astra rejects temperature/top_p, so neither is sent.
const SPLIT_LLM_PROVIDER = "openai" as const;
const SPLIT_LLM_MODEL = "gpt-pro";
const SPLIT_DISABLE_THINKING = true;

export const MAX_SPLIT_SEGMENTS = 6;

export interface SplitSegment {
  name: string;
  description: string;
  /** A token from SPLIT_ICONS. */
  icon: string;
  /** Jev's own certainty (0..1) about the icon. Decorative choice: the icon is
   * always returned; a low value just means several icons fit. */
  iconConfidence: number;
}

export interface SplitProposal {
  /** The axes the split uses, 0 (one segment, no split) to 2 (crossed). */
  axes: SplitAxis[];
  segments: SplitSegment[];
}

const SPLIT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    axes: {
      type: "array",
      items: { type: "string", enum: [...SPLIT_AXES] },
    },
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
        },
        required: ["name", "description"],
      },
    },
  },
  required: ["axes", "segments"],
};

/** Exported for the unit test that pins the split's invariants. */
export function buildSplitSystemPrompt(): string {
  return [
    "A company tells you who it sells to. You split that target into AT MOST",
    `${MAX_SPLIT_SEGMENTS} segments so a cold email campaign can test them against each`,
    "other. Each segment becomes a card the customer reads, and later a people",
    "search. Emit the split the target naturally supports, and no more.",
    "",
    "THE INVARIANT -- the segments PARTITION the target, they never redefine it:",
    "  - Mutually exclusive: no person can belong to two segments. Otherwise an",
    "    A/B result means nothing.",
    "  - Collectively exhaustive: every person in the target lands in exactly one",
    "    segment. You do not add people the target excludes, and you do not leave",
    "    out people it includes.",
    "  - WHO the customer sells to travels into EVERY segment unchanged. Only the",
    "    partition value differs between segments.",
    "",
    "SPLIT ONLY ALONG AXES A PEOPLE SEARCH CAN FILTER ON:",
    '  - "geography": where the person or company is (continents, countries,',
    "    states, regions, cantons).",
    '  - "company_size": employee headcount bands (e.g. 1-10, 11-50, 51-200,',
    "    201-1000, 1000+).",
    '  - "industry": the sector of the company.',
    '  - "seniority_role": the level or role of the person (e.g. founders and',
    "    CEOs vs heads of marketing).",
    "Never split on anything else: not buying intent, not the product, not",
    "revenue guesses, not company culture, not technology stack.",
    "",
    "HOW TO SPLIT:",
    "  - Prefer ONE axis. Use two axes only by CROSSING them (every combination",
    "    of a value of axis A with a value of axis B is one segment), and only when",
    "    the crossing stays within the segment limit. Never mix axes across",
    '    segments (never one segment "in France" beside another "with 50+',
    '    employees": those overlap).',
    "  - Pick the axis the target itself suggests. When the target names several",
    '    values of an axis ("in the US and Europe", "founders and CMOs"), that is',
    "    the natural split. Otherwise pick the axis that makes the most business",
    "    sense for the target.",
    "  - Bands of one axis must be contiguous and non-overlapping, and together",
    "    cover everything the target covers on that axis.",
    "  - State every partition value POSITIVELY and by name. Never \"other\",",
    '    "rest of", "outside X": list the members. A search cannot look for the',
    "    absence of something.",
    "  - A NARROW target that offers no meaningful split is ONE segment. One is a",
    "    correct answer. Never invent a split to fill cards.",
    `  - Never more than ${MAX_SPLIT_SEGMENTS} segments. If a natural axis has more`,
    "    values than that, group neighbouring values into named groups.",
    "",
    "WRITING EACH SEGMENT:",
    '  - "name": a short label, MAX 4 words, distinct from every other name.',
    '  - "description": ONE plain, reassuring sentence a non-expert understands,',
    "    that is ALSO a complete specification of the segment on its own: it",
    "    restates everything the target says (who, where, what kind of company)",
    "    plus this segment's partition value. Someone reading only this sentence,",
    "    without the target or the other segments, must know exactly who is in it.",
    "  - Describe ONE population, never a union. Bind generic role words",
    '    ("owner", "manager") to the sector the target names.',
    "  - Never name the customer's own product as a targeting attribute.",
    "  - Plain words, no jargon, no em dashes, no hype.",
    '  - "axes": the axes you split along (empty when you return one segment).',
    "",
    "NOT YOUR JOB: how many people a segment holds, and any search tool's filter",
    "vocabulary. Never estimate size; never write field names.",
    "",
    "Respond with ONLY valid JSON (no prose, no markdown):",
    '{"axes":["geography"],"segments":[{"name":"<=4 words","description":"one sentence"}]}',
  ].join("\n");
}

function parseSplit(obj: Record<string, unknown>): {
  axes: SplitAxis[];
  segments: Array<{ name: string; description: string }>;
} {
  const rawAxes = obj.axes;
  const rawSegments = obj.segments;
  if (!Array.isArray(rawAxes) || !Array.isArray(rawSegments)) {
    throw new ChatServiceError(502, "LLM split missing `axes` or `segments` array");
  }
  const axes = rawAxes.map((a) => {
    if (!(SPLIT_AXES as readonly string[]).includes(a as string)) {
      throw new ChatServiceError(502, `LLM split used an unfilterable axis: ${String(a)}`);
    }
    return a as SplitAxis;
  });
  if (axes.length > 2) {
    throw new ChatServiceError(502, `LLM split crossed ${axes.length} axes (max 2)`);
  }
  if (rawSegments.length < 1 || rawSegments.length > MAX_SPLIT_SEGMENTS) {
    // Truncating would silently break the partition (the dropped segments'
    // people vanish from the campaign), so an out-of-range answer fails loud.
    throw new ChatServiceError(
      502,
      `LLM split returned ${rawSegments.length} segments (expected 1-${MAX_SPLIT_SEGMENTS})`
    );
  }
  const seen = new Set<string>();
  const segments = rawSegments.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const description = typeof o.description === "string" ? o.description.trim() : "";
    if (!name || !description) {
      throw new ChatServiceError(502, `LLM split segment ${i} missing name or description`);
    }
    const k = name.toLowerCase();
    if (seen.has(k)) {
      throw new ChatServiceError(502, `LLM split returned duplicate segment name "${name}"`);
    }
    seen.add(k);
    return { name, description };
  });
  return { axes, segments };
}

/**
 * Propose the split. Two calls, both through chat-service (which owns their
 * cost): one completion writes the segments, one typed judgment picks the icons.
 * Persists nothing. Fails loud (ChatServiceError → 502) on any bad answer.
 */
export async function proposeAudienceSplit(
  targetAudience: string,
  identity: ChatIdentity
): Promise<SplitProposal> {
  const { axes, segments } = parseSplit(
    await completeJson({
      message: targetAudience,
      systemPrompt: buildSplitSystemPrompt(),
      identity,
      provider: SPLIT_LLM_PROVIDER,
      model: SPLIT_LLM_MODEL,
      responseSchema: SPLIT_RESPONSE_SCHEMA,
      disableThinking: SPLIT_DISABLE_THINKING,
    })
  );

  const questions = Object.fromEntries(
    segments.map((s, i) => [
      `segment_${i + 1}`,
      {
        instructions: `Which icon best represents segment ${i + 1} ("${s.name}": ${s.description}) for a customer glancing at it? Prefer the icon for what makes THIS segment different from the others.`,
        criteria: SPLIT_ICONS,
      },
    ])
  );
  const icons = await judgeChoices({
    state: { target: targetAudience, segments },
    questions,
    identity,
  });

  return {
    axes: segments.length === 1 ? [] : axes,
    segments: segments.map((s, i) => ({
      ...s,
      icon: icons[`segment_${i + 1}`].choice,
      iconConfidence: icons[`segment_${i + 1}`].confidence,
    })),
  };
}

export class SplitNameConflictError extends Error {
  constructor(public readonly names: string[]) {
    super(
      `An audience with this name already exists for this brand and offer: ${names.join(", ")}`
    );
    this.name = "SplitNameConflictError";
  }
}

/**
 * Create the chosen segments as ACTIVE audiences under (org, brand, offer), in
 * ONE transaction: all or nothing, so a partial confirm can never leave the
 * campaign testing half the split. Each row carries its description and the
 * confirmed target as `nlPrompt`; `provider='apollo'` with no pointer and no
 * filters — the route then builds them (see file header).
 * A name already taken in the same (org, brand, offer) scope ⟹
 * SplitNameConflictError (409), nothing written.
 */
export async function confirmAudienceSplit(args: {
  orgId: string;
  userId: string | null;
  brandId: string;
  offerId: string;
  targetAudience: string | null;
  segments: Array<{ name: string; description: string }>;
}): Promise<Array<typeof audiences.$inferSelect>> {
  return db.transaction(async (tx) => {
    const lowered = args.segments.map((s) => s.name.toLowerCase());
    const taken = await tx
      .select({ name: audiences.name })
      .from(audiences)
      .where(
        and(
          eq(audiences.orgId, args.orgId),
          eq(audiences.brandId, args.brandId),
          eq(audiences.offerId, args.offerId),
          inArray(sql`lower(${audiences.name})`, lowered)
        )
      );
    if (taken.length > 0) {
      throw new SplitNameConflictError(taken.map((t) => t.name));
    }
    return tx
      .insert(audiences)
      .values(
        args.segments.map((s) => ({
          orgId: args.orgId,
          brandId: args.brandId,
          offerId: args.offerId,
          name: s.name,
          description: s.description,
          nlPrompt: args.targetAudience,
          provider: "apollo",
          apolloAudienceId: null,
          filters: null,
          status: "active",
          source: "split_proposal",
          createdByUserId: args.userId,
        }))
      )
      .returning();
  });
}

