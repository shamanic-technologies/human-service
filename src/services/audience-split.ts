// Audience SPLIT — the light, conceptual version of shamanic-technologies/
// human-service#235. A customer states who they sell to; this proposes at most
// SIX non-overlapping segments of that target, in plain language, so a new
// campaign can A/B test them. On confirmation the chosen segments become the
// brand's ACTIVE audiences under the offer.
//
// What this deliberately does NOT do (and why it is fast):
//   - no Apollo call, no count, no filter-refinement loop. The only size is the
//     model's own rough guess (`estimatedLeadCount`), written by the SAME call
//     that writes the segments, after the split is final: zero added call, zero
//     added cost, so a card can show "14K leads" the moment it appears.
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
import { audiences, audienceSplitProposals } from "../db/schema.js";
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
import { audienceTargetFields } from "./audience-target-text.js";
import { noteListBuilt } from "./run-outputs.js";
import { completeRun, createRun } from "./runs.js";
import {
  doorCall,
  findInFlight,
  messageOf,
  registerInFlight,
  releaseInFlight,
  runServiceScript,
  scriptSwitch,
  ServiceScriptError,
  type InFlight,
  type ScriptCall,
} from "../lib/script-switch.js";

export { SPLIT_AXES, SPLIT_ICONS, type SplitAxis };

// Same model + switch as /suggest's layer 1: a user waits on this inside the
// onboarding. Claude Sonnet 5.5 (owner decision 2026-09-29, replacing GPT-6
// Astra, p50 7.4s). It rejects temperature, so neither temperature nor top_p is
// sent; `disableThinking` makes chat-service send its lowest effort (`low`).
const SPLIT_LLM_PROVIDER = "anthropic" as const;
const SPLIT_LLM_MODEL = "sonnet";
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
  /** The model's order-of-magnitude guess of how many decision-makers the
   * segment reaches in a large B2B contact database. null when it gave none
   * (never 0). Approximate by design: the real count is measured later. */
  estimatedLeadCount: number | null;
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
          estimatedLeadCount: { type: "integer" },
        },
        required: ["name", "description", "estimatedLeadCount"],
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
    "NOT YOUR JOB: any search tool's filter vocabulary (never write field names),",
    "and size as a reason to split. Never estimate size to decide the split: never",
    "merge, drop, widen or invent a segment because of how many people it holds.",
    "",
    "ONLY ONCE THE SPLIT IS FINAL, size each segment for the customer's card:",
    '  - "estimatedLeadCount": your best rough estimate, as one whole number, of',
    "    how many people matching this segment's description (the people the",
    "    customer would email: decision-makers in the companies described) are",
    "    listed in a large B2B contact database such as Apollo or LinkedIn. The",
    "    right order of magnitude is enough. Always give your best guess, never 0.",
    "",
    "Respond with ONLY valid JSON (no prose, no markdown):",
    '{"axes":["geography"],"segments":[{"name":"<=4 words","description":"one sentence","estimatedLeadCount":12000}]}',
  ].join("\n");
}

/** The model's size guess, or null when it gave none usable. Never 0: an
 * absent estimate must not read as an empty market on the card. */
function parseEstimatedLeadCount(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n > 0 ? n : null;
}

function parseSplit(obj: Record<string, unknown>, allowEmpty = false): {
  axes: SplitAxis[];
  segments: Array<{ name: string; description: string; estimatedLeadCount: number | null }>;
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
  if ((rawSegments.length < 1 && !allowEmpty) || rawSegments.length > MAX_SPLIT_SEGMENTS) {
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
    return { name, description, estimatedLeadCount: parseEstimatedLeadCount(o.estimatedLeadCount) };
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
  identity: ChatIdentity,
  opts: {
    /** ZERO segments is a valid answer (the refill asking for people left
     * inside a target: "nobody" is the truth when its audiences cover it all).
     * Default false: a customer split always gets at least one segment. */
    allowEmpty?: boolean;
  } = {}
): Promise<SplitProposal> {
  const allowEmpty = opts.allowEmpty ?? false;
  // FACTORY-P3 next outcomes (audience_built): the split runs as the stored script while switched.
  const choose = await scriptSwitch(AUDIENCE_BUILT_OUTCOME);
  if (choose.switched && choose.dynasty && identity.runId) return proposeByScript(choose.dynasty, targetAudience, identity, allowEmpty);
  return proposeHere(targetAudience, identity, allowEmpty);
}

export const AUDIENCE_BUILT_OUTCOME = "audience_built";
export const SPLIT_COMPLETE_CALL = "human.split.complete";
export const SPLIT_JUDGE_CALL = "human.split.judge";
export const SPLIT_PROPOSAL_TASK = "audience-split-proposal";

/** The split's completion request, exactly as our code sends it (the stored script states the same). */
function splitCompletion(targetAudience: string) {
  return {
    message: targetAudience,
    systemPrompt: buildSplitSystemPrompt(),
    provider: SPLIT_LLM_PROVIDER,
    model: SPLIT_LLM_MODEL,
    responseSchema: SPLIT_RESPONSE_SCHEMA,
    disableThinking: SPLIT_DISABLE_THINKING,
  };
}

function iconQuestions(segments: Array<{ name: string; description: string }>) {
  return Object.fromEntries(
    segments.map((s, i) => [
      `segment_${i + 1}`,
      {
        instructions: `Which icon best represents segment ${i + 1} ("${s.name}": ${s.description}) for a customer glancing at it? Prefer the icon for what makes THIS segment different from the others.`,
        criteria: SPLIT_ICONS,
      },
    ])
  );
}

/**
 * Propose the split, our own code. Two calls, both through chat-service (which
 * owns their cost): one completion writes the segments, one typed judgment picks
 * the icons. Persists nothing but its record in the stored script's words
 * (`audience_split_proposals`). Fails loud (ChatServiceError → 502) on any bad answer.
 */
async function proposeHere(targetAudience: string, identity: ChatIdentity, allowEmpty: boolean): Promise<SplitProposal> {
  const calls: ScriptCall[] = [];
  const request = splitCompletion(targetAudience);
  // One `audience-split-proposal` run per proposal of our own made for a caller's run (Monitoring's service path; the
  // chat calls keep the caller's run, as before). Fail-soft like every run of this service.
  const proposalRunId =
    identity.runId && identity.userId
      ? await createRun({ orgId: identity.orgId, userId: identity.userId, workflowTracking: identity.workflowTracking, parentRunId: identity.runId, taskName: SPLIT_PROPOSAL_TASK })
      : null;
  const record = async (proposal: SplitProposal | null, error: string | null) => {
    if (proposalRunId) await completeRun(proposalRunId, error ? "failed" : "completed", { orgId: identity.orgId, userId: identity.userId!, workflowTracking: identity.workflowTracking });
    await recordProposal({ identity, path: "service", runId: proposalRunId, targetAudience, allowEmpty, calls, proposal, error });
  };
  try {
    const written = await completeJson({ ...request, identity });
    calls.push({ name: SPLIT_COMPLETE_CALL, args: { ...request }, answer: { ok: true, data: written } });
    const { axes, segments } = parseSplit(written, allowEmpty);
    if (segments.length === 0) {
      const empty = { axes: [], segments: [] };
      await record(empty, null);
      return empty;
    }
    const state = { target: targetAudience, segments: segments.map(({ name, description }) => ({ name, description })) };
    const questions = iconQuestions(segments);
    const icons = await judgeChoices({ state, questions, identity });
    calls.push({ name: SPLIT_JUDGE_CALL, args: { state, questions }, answer: { ok: true, data: icons as unknown as Record<string, unknown> } });
    const proposal: SplitProposal = {
      axes: segments.length === 1 ? [] : axes,
      segments: segments.map((s, i) => ({
        ...s,
        icon: icons[`segment_${i + 1}`].choice,
        iconConfidence: icons[`segment_${i + 1}`].confidence,
      })),
    };
    await record(proposal, null);
    return proposal;
  } catch (error) {
    await record(null, messageOf(error));
    throw error;
  }
}

/** The stored script proposes; its two doors run our exact chat calls (retries included) for this proposal. */
async function proposeByScript(dynasty: string, targetAudience: string, identity: ChatIdentity, allowEmpty: boolean): Promise<SplitProposal> {
  const entry = registerInFlight({ identity });
  try {
    const out = await runServiceScript({
      outcome: AUDIENCE_BUILT_OUTCOME,
      dynasty,
      identity: { orgId: identity.orgId, userId: identity.userId ?? null, runId: identity.runId ?? null },
      subject: { service: "human", id: entry.token },
      units: { offer_described: { content: { proposal: entry.token, targetAudience, allowEmpty, icons: SPLIT_ICONS } } },
      billing: "org",
    });
    const proposal = out.content as unknown as SplitProposal | null;
    if (!proposal || !Array.isArray(proposal.axes) || !Array.isArray(proposal.segments)) throw new ServiceScriptError("the split script answered no proposal", out.runId);
    await recordProposal({ identity, path: "script", runId: out.runId, targetAudience, allowEmpty, calls: entry.calls, proposal, error: null });
    return proposal;
  } catch (error) {
    await recordProposal({ identity, path: "script", runId: error instanceof ServiceScriptError ? error.runId : null, targetAudience, allowEmpty, calls: entry.calls, proposal: null, error: messageOf(error) });
    if (entry.thrown) throw entry.thrown;
    // A bad answer of the model (the script's `unmade`): our own code's loud 502.
    if (error instanceof ServiceScriptError && error.unmade) throw new ChatServiceError(502, error.message);
    throw error;
  } finally {
    releaseInFlight(entry as InFlight<unknown>);
  }
}

/** The split script's doors: our exact completion / icon judgment for a proposal in flight. */
export async function splitDoor(token: string, scriptRunId: string, call: string, args: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const entry = findInFlight<{ identity: ChatIdentity }>(token);
  if (!entry) return { status: 409, body: { error: "no proposal in flight for this token" } };
  // Our exact call, its spend on the SCRIPT's run (a child of the caller's).
  const identity = { ...entry.work.identity, runId: scriptRunId };
  if (call === SPLIT_COMPLETE_CALL) {
    return doorCall(entry as InFlight<unknown>, call, args, () =>
      completeJson({
        message: String(args.message ?? ""),
        systemPrompt: String(args.systemPrompt ?? ""),
        identity,
        ...(args.provider ? { provider: args.provider as "anthropic" } : {}),
        ...(args.model ? { model: String(args.model) } : {}),
        ...(args.responseSchema ? { responseSchema: args.responseSchema as Record<string, unknown> } : {}),
        ...(args.disableThinking !== undefined ? { disableThinking: args.disableThinking === true } : {}),
      })
    );
  }
  if (call === SPLIT_JUDGE_CALL) {
    return doorCall(entry as InFlight<unknown>, call, args, async () =>
      (await judgeChoices({
        state: args.state as Record<string, unknown>,
        questions: args.questions as Record<string, { instructions: string; criteria: Record<string, string> }>,
        identity,
      })) as unknown as Record<string, unknown>
    );
  }
  return { status: 400, body: { error: `no call named ${call}` } };
}

async function recordProposal(r: {
  identity: ChatIdentity;
  path: "service" | "script";
  runId: string | null;
  targetAudience: string;
  allowEmpty: boolean;
  calls: ScriptCall[];
  proposal: SplitProposal | null;
  error: string | null;
}): Promise<void> {
  try {
    await db.insert(audienceSplitProposals).values({
      orgId: r.identity.orgId,
      callerRunId: r.identity.runId ?? null,
      runId: r.runId,
      path: r.path,
      targetAudience: r.targetAudience,
      allowEmpty: r.allowEmpty,
      calls: r.calls,
      proposal: r.proposal,
      error: r.error ? r.error.slice(0, 1000) : null,
    });
  } catch (error) {
    console.error(`[human-service] split proposal NOT recorded (the proposal stands): ${messageOf(error)}`);
  }
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
  /** Provenance tag. Defaults to `split_proposal` (a human confirmed it); the
   * automatic refill (audience-refill.ts) stamps `auto_refill`. */
  source?: string;
  /** Row ids minted by the caller, one per segment in order. The confirm route
   * mints them so the Apollo build can start BEFORE the rows exist (while the
   * target draft runs); omitted ⟹ the database picks them. */
  ids?: string[];
}): Promise<Array<typeof audiences.$inferSelect>> {
  const rows = await db.transaction((tx) => insertSplitAudiences(tx, args));
  for (const r of rows) noteListBuilt(r.id);
  return rows;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SplitArgs = Parameters<typeof confirmAudienceSplit>[0];

/** The segment names already taken in the (org, brand, offer) scope. A plain
 * read: the confirm route asks it BEFORE starting any build, so a 409 spends
 * nothing; the transaction asks it again, which is what makes it binding. */
export async function takenSplitNames(
  executor: Tx | typeof db,
  args: Pick<SplitArgs, "orgId" | "brandId" | "offerId" | "segments">
): Promise<string[]> {
  const lowered = args.segments.map((s) => s.name.toLowerCase());
  const taken = await executor
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
  return taken.map((t) => t.name);
}

/** The rows a split confirm inserts, one per segment, in order. */
function splitAudienceValues(args: SplitArgs) {
  if (args.ids && args.ids.length !== args.segments.length) {
    throw new Error(
      `split confirm: ${args.ids.length} minted ids for ${args.segments.length} segments`
    );
  }
  return args.segments.map((s, i) => ({
    ...(args.ids ? { id: args.ids[i] } : {}),
    orgId: args.orgId,
    brandId: args.brandId,
    offerId: args.offerId,
    name: s.name,
    description: s.description,
    nlPrompt: args.targetAudience,
    // One segment = not one of several: the target IS its text. Several:
    // each gets its own segment target, drafted after the confirm by
    // ensureTargetText (audience-target-text.ts), before its first serve.
    ...(args.segments.length === 1
      ? audienceTargetFields(args.targetAudience)
      : { targetText: null, targetTextOrigin: null }),
    provider: "apollo",
    apolloAudienceId: null,
    filters: null,
    status: "active",
    source: args.source ?? "split_proposal",
    createdByUserId: args.userId,
  }));
}

/**
 * The rows a confirm WILL insert under the minted ids, before they exist, for
 * the Apollo build to start on. Everything the build reads (id, org, brand,
 * name, description, provider, creator) is final here; the drafted target is
 * not known yet and the build never reads it (it builds from the segment's own
 * name + description), so it is null on these copies.
 */
export function prospectiveSplitRows(
  args: Omit<SplitArgs, "targetAudience"> & { ids: string[] }
): Array<typeof audiences.$inferSelect> {
  return splitAudienceValues({ ...args, targetAudience: null }).map(
    (v) => v as unknown as typeof audiences.$inferSelect
  );
}

/** confirmAudienceSplit's body, for a caller that already holds a transaction
 * (accepting a widening proposal locks the proposal row in the same one). */
export async function insertSplitAudiences(
  tx: Tx,
  args: SplitArgs
): Promise<Array<typeof audiences.$inferSelect>> {
  const taken = await takenSplitNames(tx, args);
  if (taken.length > 0) {
    throw new SplitNameConflictError(taken);
  }
  return tx.insert(audiences).values(splitAudienceValues(args)).returning();
}

