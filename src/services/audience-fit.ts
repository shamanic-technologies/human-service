// AUDIENCE-SOURCE-BY-FIT-1126: does a company / person a provider handed us belong to the
// audience's target text? ONE shared Jev judgment, whatever the provider (Apollo, Google
// Maps, any later one): the same two questions, the same state, the same pass rule.
//
// Why: the "Brazilian restaurants" preview (prod 2026-11-25) listed a catering firm, an HR
// tech company and a brewery, with "Human Resources Manager" as the person to write to,
// while the audience's own text named restaurants and said HR is OUT. The provider's
// filters had matched; nobody had asked whether the result is what the target describes.
//
// - The judge sees the target text verbatim and everything we hold about the company and
//   the person (the teaser snapshot). No title list, no keyword rule, no per-industry case.
// - ONE `/orgs/judgments` call per subject, two typed `choice` questions (company, person),
//   each with an honest "cannot tell" / "no person" option: a yes/no on thin facts squashes
//   to 0.5 (relation-fit.ts learned it).
// - Judged ONCE per (audience, provider, subject, prompt version), persisted in
//   `audience_fit_judgments` (bronze) and read back: a reload, a later page or the provider
//   measurement never pays the same question twice, and no consumer re-judges it.
// - Fail loud: a chat-service failure throws (ChatServiceError -> 502 at the route). A
//   company served unjudged would be the bug this module removes.
// - Cost: chat-service owns it (org-billed with the caller's identity, input tokens only).

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { audienceFitJudgments, type TeaserSnapshot } from "../db/schema.js";
import { judgeChoices, type ChatIdentity } from "../lib/chat-client.js";

export const AUDIENCE_FIT_PROMPT_VERSION = "audience-fit-v1";

/** Jev calls in flight at once for one batch (a preview chunk, a provider sample). */
const FIT_CONCURRENCY = 6;

export type CompanyFit = "in_target" | "out_of_target" | "unknown";
export type PersonFit = "in_target" | "out_of_target" | "no_person";

export interface FitSubject {
  /** Stable key of the subject within the provider (a company + person key). */
  key: string;
  snapshot: TeaserSnapshot;
}

export interface FitVerdict {
  key: string;
  companyFit: CompanyFit;
  companyConfidence: number;
  personFit: PersonFit;
  personConfidence: number;
  /** The company is one of the target's companies. */
  companyPasses: boolean;
  /** Company passes AND the person is one to write to (or no person is named: the business itself). */
  passes: boolean;
}

const COMPANY_QUESTION = {
  instructions: [
    "The client described the audience they want to reach (targetAudience).",
    "Judge the candidate's COMPANY only (organizationName, its industry, keywords, size, place and description as far as the facts show):",
    "is it one of the companies or businesses the target audience describes?",
    "A company of another kind (a supplier, a manufacturer, a software or HR firm serving that sector, a distributor) is not one of them, even in the same sector.",
  ].join(" "),
  criteria: {
    in_target: "The facts show this company is one of the companies or businesses the target audience describes.",
    out_of_target: "The facts show it is another kind of company, in another place, or of a size the target leaves out.",
    unknown: "The facts are too thin to tell either way.",
  },
};

const PERSON_QUESTION = {
  instructions: [
    "The client described the audience they want to reach (targetAudience), including which roles to write to,",
    "who around them is also in, and which functions are out.",
    "Judge the candidate PERSON (name, title, headline, seniority): by role and function, is this a person the target says to write to?",
    "Read the target's own ins and outs: a function it names as out is out, whatever the seniority.",
  ].join(" "),
  criteria: {
    in_target: "A person is named and their role is one the target says to write to (or one it lets in around them).",
    out_of_target: "A person is named and their role or function is one the target leaves out or names as out.",
    no_person: "No person is named on the candidate (no name and no title): only the company is known.",
  },
};

function verdictOf(key: string, row: {
  companyFit: string;
  companyConfidence: number;
  personFit: string;
  personConfidence: number;
}): FitVerdict {
  const companyFit = row.companyFit as CompanyFit;
  const personFit = row.personFit as PersonFit;
  const companyPasses = companyFit === "in_target";
  return {
    key,
    companyFit,
    companyConfidence: row.companyConfidence,
    personFit,
    personConfidence: row.personConfidence,
    companyPasses,
    passes: companyPasses && personFit !== "out_of_target",
  };
}

/** The state Jev judges: the target text verbatim and the candidate. */
export function buildFitState(target: string, snapshot: TeaserSnapshot): Record<string, unknown> {
  return { targetAudience: target, candidate: snapshot };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The verdict for every subject, in order: stored ones read back, the rest judged now (one
 * Jev call each) and persisted. A concurrent judge of the same subject keeps the first row.
 */
export async function judgeAudienceFit(args: {
  audienceId: string;
  provider: string;
  target: string;
  subjects: FitSubject[];
  identity: ChatIdentity;
}): Promise<FitVerdict[]> {
  const { audienceId, provider, target, subjects, identity } = args;
  if (subjects.length === 0) return [];
  const keys = [...new Set(subjects.map((s) => s.key))];
  const stored = await db
    .select()
    .from(audienceFitJudgments)
    .where(
      and(
        eq(audienceFitJudgments.audienceId, audienceId),
        eq(audienceFitJudgments.provider, provider),
        eq(audienceFitJudgments.promptVersion, AUDIENCE_FIT_PROMPT_VERSION),
        inArray(audienceFitJudgments.subjectKey, keys)
      )
    );
  const byKey = new Map(stored.map((r) => [r.subjectKey, verdictOf(r.subjectKey, r)]));

  const todo = [...new Map(subjects.filter((s) => !byKey.has(s.key)).map((s) => [s.key, s])).values()];
  const judged = await mapLimit(todo, FIT_CONCURRENCY, async (s) => {
    const answers = await judgeChoices({
      state: buildFitState(target, s.snapshot),
      questions: { company: COMPANY_QUESTION, person: PERSON_QUESTION },
      identity,
    });
    return {
      subject: s,
      companyFit: answers.company.choice,
      companyConfidence: answers.company.confidence,
      personFit: answers.person.choice,
      personConfidence: answers.person.confidence,
    };
  });
  if (judged.length > 0) {
    await db
      .insert(audienceFitJudgments)
      .values(
        judged.map((j) => ({
          audienceId,
          provider,
          subjectKey: j.subject.key,
          promptVersion: AUDIENCE_FIT_PROMPT_VERSION,
          targetText: target,
          subject: j.subject.snapshot as unknown as Record<string, unknown>,
          companyFit: j.companyFit,
          companyConfidence: j.companyConfidence,
          personFit: j.personFit,
          personConfidence: j.personConfidence,
        }))
      )
      .onConflictDoNothing();
    for (const j of judged) {
      const v = verdictOf(j.subject.key, j);
      byKey.set(j.subject.key, v);
      console.log(
        `[human-service] audience_fit.judged audience=${audienceId} provider=${provider} subject=${JSON.stringify(j.subject.key)} company=${v.companyFit} person=${v.personFit} passes=${v.passes}`
      );
    }
  }
  return subjects.map((s) => byKey.get(s.key)!);
}

/** The stored verdicts of these subjects (never judges): key -> verdict, absent when never judged. */
export async function readStoredFit(audienceId: string, provider: string, keys: string[]): Promise<Map<string, FitVerdict>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select()
    .from(audienceFitJudgments)
    .where(
      and(
        eq(audienceFitJudgments.audienceId, audienceId),
        eq(audienceFitJudgments.provider, provider),
        eq(audienceFitJudgments.promptVersion, AUDIENCE_FIT_PROMPT_VERSION),
        inArray(audienceFitJudgments.subjectKey, [...new Set(keys)])
      )
    );
  return new Map(rows.map((r) => [r.subjectKey, verdictOf(r.subjectKey, r)]));
}

/** Every stored verdict of one provider for an audience, oldest first, with the subject judged
 * (the provider measurement's sample). */
export async function readProviderFit(
  audienceId: string,
  provider: string
): Promise<Array<FitVerdict & { company: string | null; person: string | null }>> {
  const rows = await db
    .select()
    .from(audienceFitJudgments)
    .where(
      and(
        eq(audienceFitJudgments.audienceId, audienceId),
        eq(audienceFitJudgments.provider, provider),
        eq(audienceFitJudgments.promptVersion, AUDIENCE_FIT_PROMPT_VERSION)
      )
    )
    .orderBy(asc(audienceFitJudgments.createdAt), asc(audienceFitJudgments.id));
  return rows.map((r) => {
    const snap = r.subject as Partial<TeaserSnapshot>;
    return {
      ...verdictOf(r.subjectKey, r),
      company: snap.organizationName ?? null,
      person: snap.title ?? snap.name ?? null,
    };
  });
}
