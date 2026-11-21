// RELATION FIT (OUTREACH-3WAYS-1121, owner 2026-11-21): a person a brand-relation list finds is offered to the
// relation's audience only once Jev says they belong to the relation.
//
// Why: a relation list is an Apollo search, and Apollo matches words. distribute.you's "Leaders at competitor
// companies" list (built from Artisan AI, 11x, Belkins, Salesloft...) holds people whose employer only shares a
// keyword with the industry. The owner's rule: every industry peer works at a company in the brand's own
// industry, judged per company; every investor invests in companies, not just works at a fund-shaped name.
//
//   - industry_peers: ONE question per COMPANY (its domain, else its name): "does this company sell what the brand
//     sells?", from the company's own facts only (name, domain, industry, keywords, size, country), never the
//     person's role (the audience's text and lead-service's screen judge the person).
//   - investors: ONE question per PERSON (title, headline, employer): "does this person invest equity in
//     companies?". An angel's employer is often their own startup, so the company alone cannot answer.
//
// Judged ONCE and persisted (`relation_fit_judgments`, unique per org x brand x relation x subject x prompt
// version): a company seen again, by any walk or the list screen, is read, never re-judged. A new prompt version
// judges again and keeps the history. Pass = P(yes) > 0.5 (the screen's bar). Jev bills input tokens to the
// serve's org (chat-service owns the cost). Fail loud: an unreadable judgment throws, nobody is offered unjudged.
// A subject with no facts at all (no company name nor domain) cannot be judged: not offered, logged.

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { relationFitJudgments, type BrandRelation, type TeaserSnapshot } from "../db/schema.js";
import { judgeYesNo } from "../lib/chat-client.js";
import { getBrandIdentity } from "../lib/brand-identity.js";
import { listBrandOffers } from "../lib/brand-offers.js";
import type { Identity } from "./people-providers.js";

export const RELATION_FIT_PROMPT_VERSION = "relation-fit-v1";
/** Strict: 0.50 is a no (same bar as the pre-pay screen). */
export const RELATION_FIT_MIN_YES_PROBABILITY = 0.5;

export interface RelationFitSubjectInput {
  providerPersonId: string;
  teaser: TeaserSnapshot | null;
  organizationDomain: string | null;
}

export interface RelationFitSubject {
  key: string;
  facts: Record<string, unknown>;
}

export type RelationFit =
  | { fits: boolean; yesProbability: number; judged: "now" | "stored"; subjectKey: string }
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
    return { key: domain ? `company:domain:${domain}` : `company:name:${companyName!.toLowerCase()}`, facts: company };
  }
  if (!t?.title && !t?.headline && !companyName) return null;
  return {
    key: `person:${s.providerPersonId}`,
    facts: { title: t?.title ?? null, headline: t?.headline ?? null, seniority: t?.seniority ?? null, country: t?.country ?? null, employer: company },
  };
}

const INSTRUCTIONS: Record<BrandRelation, string> = {
  industry_peers: [
    "You judge ONE company, never a person.",
    "The brand and the population describe the brand's industry: the companies that sell what the brand sells, its competitors named in the population included.",
    "Answer yes only when this company itself sells the same kind of product or service as the brand or those competitors, to the same kind of customer: a competitor or a company in the same line of business.",
    "Judge from what the company does: its name, domain, industry and keywords.",
    "Sharing one word with the brand's market is not enough: a company whose main business is something else, or that buys from this industry rather than selling in it, is a no.",
  ].join("\n"),
  investors: [
    "You judge ONE person.",
    "Answer yes only when this person invests equity in companies themselves: a business angel, an angel syndicate lead, or a partner, principal or investment professional who picks deals at a venture capital firm, angel network or family office.",
    "Judge from their title, headline and employer.",
    "Working at an organization whose name sounds like a fund is not enough: people who serve investors (lawyers, accountants, recruiters, fund administration, marketing, operations) and founders raising money are a no.",
  ].join("\n"),
};

interface BrandContext {
  name: string;
  domain: string | null;
  sells: string[];
}

const BRAND_CONTEXT_TTL_MS = 10 * 60_000;
const brandContextCache = new Map<string, { at: number; value: BrandContext }>();

/** The brand as Jev sees it: its name, domain and what its offers sell (brand-service). Cached 10 min. */
async function brandContext(orgId: string, brandId: string): Promise<BrandContext> {
  const key = `${orgId}:${brandId}`;
  const hit = brandContextCache.get(key);
  if (hit && Date.now() - hit.at < BRAND_CONTEXT_TTL_MS) return hit.value;
  const [brand, offers] = await Promise.all([getBrandIdentity(brandId, orgId), listBrandOffers(brandId, orgId)]);
  const value: BrandContext = {
    name: brand.name,
    domain: brand.domain,
    sells: offers.map((o) => (o.description ? `${o.name}: ${o.description}` : o.name)),
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
  if (stored) return { fits: stored.verdict, yesProbability: stored.yesProbability, judged: "stored", subjectKey: subject.key };

  const population = (target.targetText ?? target.nlPrompt ?? "").trim();
  const brand = await brandContext(target.orgId, target.brandId);
  const state =
    relation === "industry_peers"
      ? { brand, population, company: subject.facts }
      : { brand: { name: brand.name, domain: brand.domain }, population, person: subject.facts };
  const answer = await judgeYesNo({ state, instructions: INSTRUCTIONS[relation], identity });
  const verdict = answer.yesProbability > RELATION_FIT_MIN_YES_PROBABILITY;
  await db
    .insert(relationFitJudgments)
    .values({
      orgId: target.orgId,
      brandId: target.brandId,
      relation,
      subjectKey: subject.key,
      promptVersion: RELATION_FIT_PROMPT_VERSION,
      verdict,
      yesProbability: answer.yesProbability,
      model: answer.model,
      facts: subject.facts,
      population,
    })
    .onConflictDoNothing();
  console.log(
    `[human-service] relation_fit.judged org=${target.orgId} brand=${target.brandId} relation=${relation} subject=${JSON.stringify(subject.key)} p=${answer.yesProbability.toFixed(2)} fits=${verdict}`
  );
  return { fits: verdict, yesProbability: answer.yesProbability, judged: "now", subjectKey: subject.key };
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
