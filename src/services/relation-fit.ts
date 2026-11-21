// RELATION FIT (OUTREACH-3WAYS-1121, owner 2026-11-21): a person a brand-relation list finds is offered to the
// relation's audience only once Jev says they belong to the relation.
//
// Why: a relation list is an Apollo search, and Apollo matches words. distribute.you's "Leaders at competitor
// companies" list (Apollo tag "sales engagement") held NextGen Healthcare staff ("patient engagement"). The owner's
// rule: every industry peer works at a company in the brand's own industry, judged per company; every investor
// invests in companies, not just works at a fund-shaped name.
//
//   - industry_peers: ONE Jev `choice` per COMPANY (its domain, else its name): brand_industry | other_market |
//     unknown. Jev sees the company's facts (the free teaser often carries only its name), the tags the list's
//     search matched it on (a hint), what the brand sells (brand-service `whatTheySell`, else its described offers)
//     and the population text naming the competitors. Never the person's role.
//   - investors: ONE `choice` per PERSON (title, headline, employer): investor | not_investor | unknown. An angel's
//     employer is often their own startup, so the company alone cannot answer.
// Only `brand_industry` / `investor` pass; `unknown` never does (nothing says they belong).
//
// v1 (a yes/no P > 0.5) was replayed on 60 companies of distribute.you's list and squashed every answer to 0.3-0.6:
// Apollo.io, ZoomInfo, Chili Piper failed. v2 replayed on 81: 76 brand_industry, out = NextGen Healthcare, a video
// studio, a financial-services firm, a creative studio, Common Room.
//
// Judged ONCE and persisted (`relation_fit_judgments`, unique per org x brand x relation x subject x prompt
// version): a company seen again, by any walk or the list screen, is read, never re-judged. A new prompt version
// judges again and keeps the history. Jev bills the serve's org (chat-service owns the cost). Fail loud: an
// unreadable judgment throws, nobody is offered unjudged. A subject with no facts at all is not offered, logged.

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { relationFitJudgments, type BrandRelation, type TeaserSnapshot } from "../db/schema.js";
import { judgeChoices } from "../lib/chat-client.js";
import { getBrandIdentity } from "../lib/brand-identity.js";
import { getBrandWhatTheySell } from "../lib/brand-extracted-fields.js";
import { listBrandOffers } from "../lib/brand-offers.js";
import type { Identity } from "./people-providers.js";

export const RELATION_FIT_PROMPT_VERSION = "relation-fit-v2";

export interface RelationFitSubjectInput {
  providerPersonId: string;
  teaser: TeaserSnapshot | null;
  organizationDomain: string | null;
  /** The company tags the list's search matched on (its Apollo keyword filters), a hint for the judge. */
  searchTags?: string[] | null;
}

export interface RelationFitSubject {
  key: string;
  facts: Record<string, unknown>;
}

export type RelationFit =
  | { fits: boolean; choice: string; confidence: number; judged: "now" | "stored"; subjectKey: string }
  | { fits: false; reason: "no_facts" };

function normDomain(d: string | null | undefined): string | null {
  const v = (d ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  return v || null;
}

/** What one judgment is about, and the facts Jev sees. null = nothing to judge. */
export function relationFitSubject(relation: BrandRelation, s: RelationFitSubjectInput): RelationFitSubject | null {
  const t = s.teaser;
  const domain = normDomain(s.organizationDomain);
  const companyName = t?.organizationName?.trim() || null;
  const company = {
    name: companyName,
    domain,
    industry: t?.organizationIndustry ?? null,
    keywords: t?.organizationKeywords ?? null,
    employees: t?.organizationEmployees ?? null,
    country: t?.organizationCountry ?? null,
  };
  if (relation === "industry_peers") {
    if (!domain && !companyName) return null;
    const facts = s.searchTags && s.searchTags.length > 0 ? { ...company, foundBySearchFor: s.searchTags } : company;
    return { key: domain ? `company:domain:${domain}` : `company:name:${companyName!.toLowerCase()}`, facts };
  }
  if (!t?.title && !t?.headline && !companyName) return null;
  return {
    key: `person:${s.providerPersonId}`,
    facts: { title: t?.title ?? null, headline: t?.headline ?? null, seniority: t?.seniority ?? null, country: t?.country ?? null, employer: company },
  };
}

interface RelationQuestion {
  instructions: string;
  criteria: Record<string, string>;
  /** The one choice that puts the subject in the relation. */
  pass: string;
}

const QUESTIONS: Record<BrandRelation, RelationQuestion> = {
  industry_peers: {
    instructions: [
      "You judge ONE company, never a person. Say which market the company's main business is in.",
      "The brand's industry is the market the brand (what it sells is stated) and the competitors named in the population sell into, taken as a whole, whatever form a company takes in it (software, data, a done-for-you service, an agency, an AI product).",
      "Use everything given: the company's facts, what you know of it by its name and domain, and `foundBySearchFor`: the company tags a provider's company search matched it on (a hint, not proof: a tag can match a word used in another market).",
    ].join("\n"),
    criteria: {
      brand_industry: "Its main business sells into the brand's industry, competitors and close neighbours included.",
      other_market:
        "Its main business serves another market, even if a word in its name, keywords or matched tags matches the brand's market, or it mainly buys from this market rather than selling in it.",
      unknown: "Nothing given or known says what its main business is.",
    },
    pass: "brand_industry",
  },
  investors: {
    instructions: [
      "You judge ONE person. Say whether this person invests equity in companies themselves.",
      "Use their title, headline and employer, and what you know of the employer by its name and domain.",
    ].join("\n"),
    criteria: {
      investor:
        "They invest equity in companies themselves: a business angel, an angel syndicate lead, or a partner, principal or investment professional who picks deals at a venture capital firm, angel network or family office.",
      not_investor:
        "They do not pick investments themselves, even at an organization whose name sounds like a fund: people who serve investors (lawyers, accountants, recruiters, fund administration, marketing, operations), founders raising money, anyone else.",
      unknown: "Nothing given or known says whether they invest.",
    },
    pass: "investor",
  },
};

interface BrandContext {
  name: string;
  domain: string | null;
  /** What the brand sells: brand-service's `whatTheySell`, else its offers that state what they sell. */
  sells: string[];
}

const BRAND_CONTEXT_TTL_MS = 10 * 60_000;
const brandContextCache = new Map<string, { at: number; value: BrandContext }>();

/** The brand as Jev sees it: its name, domain and what its offers sell (brand-service). Cached 10 min. */
async function brandContext(orgId: string, brandId: string): Promise<BrandContext> {
  const key = `${orgId}:${brandId}`;
  const hit = brandContextCache.get(key);
  if (hit && Date.now() - hit.at < BRAND_CONTEXT_TTL_MS) return hit.value;
  const [brand, whatTheySell, offers] = await Promise.all([
    getBrandIdentity(brandId, orgId),
    getBrandWhatTheySell(brandId),
    listBrandOffers(brandId, orgId),
  ]);
  const value: BrandContext = {
    name: brand.name,
    domain: brand.domain,
    // An offer without a description says nothing about the market (distribute.you: "Angel round", "Give-list probe").
    sells: whatTheySell ? [whatTheySell] : offers.filter((o) => o.description).map((o) => `${o.name}: ${o.description}`),
  };
  brandContextCache.set(key, { at: Date.now(), value });
  return value;
}

export function clearRelationFitCaches(): void {
  brandContextCache.clear();
  inFlight.clear();
}

const inFlight = new Map<string, Promise<RelationFit>>();

/**
 * Does this person belong to the relation of `target` (a relation audience)? The stored verdict when there is
 * one, else one Jev question, persisted. `identity` bills the judgment (the serve's org).
 */
export async function judgeRelationFit(
  target: { orgId: string; brandId: string; relation: string | null; targetText: string | null; nlPrompt: string | null; id: string },
  subjectIn: RelationFitSubjectInput,
  identity: Identity
): Promise<RelationFit> {
  const relation = target.relation as BrandRelation;
  const subject = relationFitSubject(relation, subjectIn);
  if (!subject) {
    console.log(
      `[human-service] relation_fit.no_facts org=${target.orgId} audience=${target.id} relation=${relation} person=${subjectIn.providerPersonId}`
    );
    return { fits: false, reason: "no_facts" };
  }
  const flightKey = `${target.orgId}:${target.brandId}:${relation}:${subject.key}`;
  const running = inFlight.get(flightKey);
  if (running) return running;
  const p = judgeSubject(target, relation, subject, identity).finally(() => inFlight.delete(flightKey));
  inFlight.set(flightKey, p);
  return p;
}

async function judgeSubject(
  target: { orgId: string; brandId: string; targetText: string | null; nlPrompt: string | null; id: string },
  relation: BrandRelation,
  subject: RelationFitSubject,
  identity: Identity
): Promise<RelationFit> {
  const where = and(
    eq(relationFitJudgments.orgId, target.orgId),
    eq(relationFitJudgments.brandId, target.brandId),
    eq(relationFitJudgments.relation, relation),
    eq(relationFitJudgments.subjectKey, subject.key),
    eq(relationFitJudgments.promptVersion, RELATION_FIT_PROMPT_VERSION)
  );
  const [stored] = await db.select().from(relationFitJudgments).where(where).limit(1);
  if (stored) return { fits: stored.verdict, choice: stored.choice ?? "", confidence: stored.yesProbability, judged: "stored", subjectKey: subject.key };

  const population = (target.targetText ?? target.nlPrompt ?? "").trim();
  const brand = await brandContext(target.orgId, target.brandId);
  const state =
    relation === "industry_peers"
      ? { brand, population, company: subject.facts }
      : { brand: { name: brand.name, domain: brand.domain }, population, person: subject.facts };
  const question = QUESTIONS[relation];
  const answers = await judgeChoices({ state, questions: { answer: { instructions: question.instructions, criteria: question.criteria } }, identity });
  const answer = answers.answer!;
  const verdict = answer.choice === question.pass;
  await db
    .insert(relationFitJudgments)
    .values({
      orgId: target.orgId,
      brandId: target.brandId,
      relation,
      subjectKey: subject.key,
      promptVersion: RELATION_FIT_PROMPT_VERSION,
      verdict,
      choice: answer.choice,
      // The choice's confidence (v1 rows: P(yes)).
      yesProbability: answer.confidence,
      model: "jev",
      facts: subject.facts,
      population,
    })
    .onConflictDoNothing();
  console.log(
    `[human-service] relation_fit.judged org=${target.orgId} brand=${target.brandId} relation=${relation} subject=${JSON.stringify(subject.key)} choice=${answer.choice} confidence=${answer.confidence.toFixed(2)} fits=${verdict}`
  );
  return { fits: verdict, choice: answer.choice, confidence: answer.confidence, judged: "now", subjectKey: subject.key };
}

/** The stored verdict for one subject, or null when never judged (current prompt version). */
export async function readRelationFit(orgId: string, brandId: string, relation: BrandRelation, subjectKey: string) {
  const [row] = await db
    .select()
    .from(relationFitJudgments)
    .where(
      and(
        eq(relationFitJudgments.orgId, orgId),
        eq(relationFitJudgments.brandId, brandId),
        eq(relationFitJudgments.relation, relation),
        eq(relationFitJudgments.subjectKey, subjectKey),
        eq(relationFitJudgments.promptVersion, RELATION_FIT_PROMPT_VERSION)
      )
    )
    .limit(1);
  return row ?? null;
}

/** The company tags a list's Apollo search matches on (its keyword filters), shown to the judge as a hint. */
export function searchTagsOf(filters: unknown): string[] | null {
  if (!filters || typeof filters !== "object") return null;
  const f = filters as Record<string, unknown>;
  const tags: string[] = [];
  if (Array.isArray(f.q_organization_keyword_tags)) tags.push(...f.q_organization_keyword_tags.filter((t): t is string => typeof t === "string"));
  if (typeof f.q_keywords === "string" && f.q_keywords.trim()) tags.push(f.q_keywords.trim());
  return tags.length > 0 ? tags : null;
}
