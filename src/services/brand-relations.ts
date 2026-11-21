// BRAND RELATIONS (OUTREACH-3WAYS-1121, owner 2026-11-21).
//
// A brand reaches people who are NOT buyers of one of its offers: its equity
// INVESTORS (start a conversation) and its INDUSTRY PEERS (founders and leaders of
// companies in its industry, competitors included: network, learn from each
// other). Every audience used to hang on a buyer offer, so these populations had no
// home: distribute.you's angel lists sat on an archived "Angel round" offer and
// nothing could serve them.
//
// `audiences.relation` names who an audience is to the brand (NULL = buyers of its
// offer). A relation audience is shaped exactly like an offer's (offer-audiences.ts):
//   - ONE target per (org, brand, relation): role 'target', NO offer, its text = who
//     the population is. Served through the shared candidate path
//     (`POST /orgs/audiences/{id}/candidates/next`, reveal, decline), each person
//     judged against its text, like every offer audience.
//   - its LISTS: role 'search' rows carrying the same relation, walked ONLY by that
//     relation's target. An offer's target never walks a relation list, and a
//     relation's target never walks the buyer lists (brandListsOf).
//
// DONE FOR YOU, never asked: `ensureBrandRelations` builds what a brand lacks from
// what we know about it (its name and domain from brand-service, its competitors
// from brand-service's discovery). Investors: one Apollo list of business angels and
// early-stage VCs. Peers: one Apollo list of leaders at companies selling what the
// brand's competitors sell (no competitors known yet = later, never invented). The
// list's Apollo filters are the shared pointer build (ensureApolloPointer), in the
// background. Same code for every brand; no per-brand rule.
//
// ADOPTION (`assignBrandRelation`): existing rows (a target, lists) become a
// relation, their offer cleared, recorded in `brand_relation_assignments` under a
// reason tag so `/revert` restores relation, role and offer verbatim.
//
// THE READ (`listBrandRelations`, `GET /orgs/audiences/relations?brandId=`): every
// relation of the brand, built or not, with its target audience id, text, lists and
// how many people its lists can still reach (each list's free provider count minus
// the brand's suppressed members, the audience list's own Remaining).

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences, audienceTeaserBuffer, brandRelationAssignments, type BrandRelation } from "../db/schema.js";
import { BRAND_RELATIONS } from "../lib/brand-relations.js";
import { getBrandIdentity } from "../lib/brand-identity.js";
import { discoverBrandCompetitors, type BrandCompetitor } from "../lib/brand-competitors.js";
import { peopleSearch, type Identity, type PeopleSearchFilters } from "./people-providers.js";
import { computeAudienceContactability, ensureApolloPointer, hasApolloNativeFilters } from "./audiences.js";
import { bufferTeasers } from "./teaser-buffer.js";
import { judgeRelationFit, readRelationFit, relationFitSubject } from "./relation-fit.js";
import { systemStatus } from "./audience-status-origin.js";
import { completeRun, createRun } from "./runs.js";

type AudienceRow = typeof audiences.$inferSelect;

export const BRAND_RELATION_SOURCE_TAG = "brand_relation";

export class BrandRelationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// ─── The read ────────────────────────────────────────────────────────────────

export interface BrandRelationListView {
  audienceId: string;
  name: string;
  status: string;
  provider: string | null;
  /** null = the list's Apollo filters are still being built (or its pool is unknown). */
  sizeCount: number | null;
  availableToContactCount: number | null;
}

export interface BrandRelationView {
  relation: BrandRelation;
  /** THE audience of the relation (serve it with candidates/next); null = not built yet. */
  audienceId: string | null;
  name: string | null;
  status: string | null;
  targetText: string | null;
  /** People the relation's ACTIVE lists can still reach (sum of their Remaining); null = no list measured yet. */
  reachableCount: number | null;
  lists: BrandRelationListView[];
}

export async function listBrandRelations(orgId: string, brandId: string): Promise<BrandRelationView[]> {
  const rows = await db
    .select()
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, orgId),
        eq(audiences.brandId, brandId),
        inArray(audiences.relation, [...BRAND_RELATIONS]),
        ne(audiences.status, "deprecated")
      )
    );
  const lists = rows.filter((r) => r.role === "search");
  const contact = await computeAudienceContactability(lists);
  return BRAND_RELATIONS.map((relation) => {
    const target = rows.find((r) => r.relation === relation && r.role === "target") ?? null;
    const own = lists
      .filter((l) => l.relation === relation)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((l): BrandRelationListView => {
        const c = contact.get(l.id) ?? null;
        const built = !!l.apolloAudienceId || (!!l.filters && Object.keys(l.filters).length > 0) || l.provider !== "apollo";
        return {
          audienceId: l.id,
          name: l.name,
          status: l.status,
          provider: l.provider,
          sizeCount: built && c ? c.sizeCount : null,
          availableToContactCount: built && c ? c.availableToContactCount : null,
        };
      });
    const measured = own.filter((l) => l.status === "active" && l.availableToContactCount !== null);
    return {
      relation,
      audienceId: target?.id ?? null,
      name: target?.name ?? null,
      status: target?.status ?? null,
      targetText: target ? (target.targetText ?? target.nlPrompt) : null,
      reachableCount: measured.length ? measured.reduce((n, l) => n + (l.availableToContactCount ?? 0), 0) : null,
      lists: own,
    };
  });
}

// ─── Done for you ────────────────────────────────────────────────────────────

/** Who the population is, from what we know about the brand (never asked from the client). */
export function relationTargetText(relation: BrandRelation, brand: { name: string; domain: string | null }, competitors: BrandCompetitor[]): string {
  const who = brand.domain ? `${brand.name} (${brand.domain})` : brand.name;
  if (relation === "investors") {
    return (
      `Equity investors who could back ${who}: business angels, angel syndicate leads, and partners or principals ` +
      `at pre-seed, seed and Series A venture capital firms who invest in startups like ${brand.name}. ` +
      `Founders raising money and service providers to investors are out.`
    );
  }
  return (
    `Founders, CEOs and senior sales, growth or marketing leaders of companies in the same industry as ${who}: ` +
    `companies that sell what ${brand.name} sells, competitors included, such as ${competitorList(competitors)}. ` +
    `People at ${brand.name} itself are out.`
  );
}

/** The search the list's Apollo filters are built from (the shared pointer build reads name + description). */
export function relationListSpec(relation: BrandRelation, competitors: BrandCompetitor[]): { name: string; description: string } {
  if (relation === "investors") {
    return {
      name: "Early-stage investors",
      description:
        "Business angels, angel syndicate leads, and partners or principals at pre-seed, seed and Series A venture capital firms.",
    };
  }
  return {
    name: "Leaders at competitor companies",
    description: `Founders, CEOs and heads of sales, growth or marketing at companies that sell the same thing as ${competitorList(competitors)}.`,
  };
}

const RELATION_TARGET_NAME: Record<BrandRelation, string> = { investors: "Investors", industry_peers: "Industry peers" };

function competitorList(competitors: BrandCompetitor[]): string {
  return competitors
    .slice(0, 8)
    .map((c) => (c.domain ? `${c.name} (${c.domain})` : c.name))
    .join(", ");
}

export interface EnsureRelationResult {
  relation: BrandRelation;
  target: "exists" | "created" | "skipped";
  list: "exists" | "created" | "skipped";
  /** Why nothing was built (peers: the brand's competitors are not known yet). */
  reason?: "competitors_not_computed" | "no_competitors";
  audienceId: string | null;
  listAudienceId: string | null;
}

/**
 * Build the relation audiences a brand lacks: its target (text from the brand) and one list (Apollo filters built
 * in the background by the shared pointer build). Idempotent: an existing target or ACTIVE/paused list is kept.
 * `identity` must carry a user (the pointer build opens its own run under it, org-billed).
 */
export async function ensureBrandRelations(
  input: { orgId: string; brandId: string; relations: readonly BrandRelation[] },
  identity: Identity
): Promise<EnsureRelationResult[]> {
  const { orgId, brandId } = input;
  if (!identity.userId) throw new BrandRelationError("x-user-id is required to build a brand's relation audiences", 400);
  const existing = await db
    .select()
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, orgId),
        eq(audiences.brandId, brandId),
        inArray(audiences.relation, [...input.relations]),
        inArray(audiences.status, ["active", "paused", "suggested"])
      )
    );
  const brand = await getBrandIdentity(brandId, orgId);
  let competitors: { status: "computed"; list: BrandCompetitor[] } | { status: "not_computed" } | null = null;
  const readCompetitors = async () => {
    if (competitors) return competitors;
    const discovery = await withOwnRun(identity, brandId, (id) => discoverBrandCompetitors(brandId, id));
    competitors = discovery.status === "computed" ? { status: "computed", list: discovery.competitors } : { status: "not_computed" };
    return competitors;
  };

  const results: EnsureRelationResult[] = [];
  for (const relation of input.relations) {
    const target = existing.find((r) => r.relation === relation && r.role === "target") ?? null;
    const list = existing.find((r) => r.relation === relation && r.role === "search") ?? null;
    if (target && list) {
      results.push({ relation, target: "exists", list: "exists", audienceId: target.id, listAudienceId: list.id });
      continue;
    }
    let known: BrandCompetitor[] = [];
    if (relation === "industry_peers") {
      const c = await readCompetitors();
      const reason = c.status === "not_computed" ? "competitors_not_computed" : c.list.length === 0 ? "no_competitors" : null;
      if (reason) {
        console.log(`[human-service] brand_relation.skipped org=${orgId} brand=${brandId} relation=${relation} reason=${reason}`);
        results.push({ relation, target: target ? "exists" : "skipped", list: list ? "exists" : "skipped", reason, audienceId: target?.id ?? null, listAudienceId: list?.id ?? null });
        continue;
      }
      known = (c as { list: BrandCompetitor[] }).list;
    }
    const created = await db.transaction(async (tx) => {
      let targetRow = target;
      let listRow = list;
      if (!targetRow) {
        const text = relationTargetText(relation, brand, known);
        [targetRow] = await tx
          .insert(audiences)
          .values({
            orgId,
            brandId,
            offerId: null,
            relation,
            name: await freeName(orgId, brandId, RELATION_TARGET_NAME[relation]),
            nlPrompt: text,
            targetText: text,
            targetTextOrigin: "audience_target",
            provider: "apollo",
            role: "target",
            status: "active",
            source: BRAND_RELATION_SOURCE_TAG,
            createdByUserId: identity.userId,
            ...systemStatus("brand_relation"),
          })
          .returning();
        await tx.insert(brandRelationAssignments).values({ reason: "ensure", orgId, brandId, audienceId: targetRow.id, relation, action: "target_created" });
      }
      if (!listRow) {
        const spec = relationListSpec(relation, known);
        [listRow] = await tx
          .insert(audiences)
          .values({
            orgId,
            brandId,
            offerId: null,
            relation,
            name: await freeName(orgId, brandId, spec.name),
            description: spec.description,
            nlPrompt: spec.description,
            provider: "apollo",
            role: "search",
            status: "active",
            source: BRAND_RELATION_SOURCE_TAG,
            createdByUserId: identity.userId,
            ...systemStatus("brand_relation"),
          })
          .returning();
        await tx.insert(brandRelationAssignments).values({ reason: "ensure", orgId, brandId, audienceId: listRow.id, relation, action: "search_created" });
      }
      return { targetRow: targetRow!, listRow: listRow!, newTarget: !target, newList: !list };
    });
    if (created.newList) {
      // The list's Apollo filters: the shared pointer build (~2-3 min), on its own run, org-billed.
      const built = created.listRow;
      void ensureApolloPointer(built, { orgId, userId: identity.userId }).catch((err) =>
        console.error(`[human-service] brand_relation.list_build_failed org=${orgId} brand=${brandId} audience=${built.id}:`, err)
      );
    }
    console.log(
      `[human-service] brand_relation.ensured org=${orgId} brand=${brandId} relation=${relation} target=${created.newTarget ? "created" : "exists"} list=${created.newList ? "created" : "exists"}`
    );
    results.push({
      relation,
      target: created.newTarget ? "created" : "exists",
      list: created.newList ? "created" : "exists",
      audienceId: created.targetRow.id,
      listAudienceId: created.listRow.id,
    });
  }
  return results;
}

/** A name free under the offer-less name index (org, brand, lower(name)), date-suffixed on a collision. */
async function freeName(orgId: string, brandId: string, base: string): Promise<string> {
  const taken = await db
    .select({ name: audiences.name })
    .from(audiences)
    .where(and(eq(audiences.orgId, orgId), eq(audiences.brandId, brandId), isNull(audiences.offerId)));
  const names = new Set(taken.map((t) => t.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  const dated = `${base} (${new Date().toISOString().slice(0, 10)})`;
  if (!names.has(dated.toLowerCase())) return dated;
  return `${base} (${new Date().toISOString().slice(0, 19)})`;
}

/** Run `fn` under the caller's run, else one opened for it (brand-service bills the discovery on a child of it). */
async function withOwnRun<T>(identity: Identity, brandId: string, fn: (identity: Identity) => Promise<T>): Promise<T> {
  if (identity.runId) return fn(identity);
  const tracking = { ...(identity.workflowTracking ?? {}), brandIds: [brandId] };
  const runId = await createRun({ orgId: identity.orgId, userId: identity.userId!, taskName: "brand-relation-audiences", workflowTracking: tracking });
  if (!runId) throw new BrandRelationError("runs-service did not open a run for the brand relation build", 502);
  const runIdentity = { orgId: identity.orgId, userId: identity.userId!, workflowTracking: tracking };
  try {
    const out = await fn({ ...identity, runId, workflowTracking: tracking });
    await completeRun(runId, "completed", runIdentity);
    return out;
  } catch (err) {
    await completeRun(runId, "failed", runIdentity);
    throw err;
  }
}

// ─── Adoption ────────────────────────────────────────────────────────────────

export interface AssignRelationInput {
  reason: string;
  orgId: string;
  brandId: string;
  relation: BrandRelation;
  targetAudienceId?: string;
  searchAudienceIds: string[];
  dryRun: boolean;
}

export interface AssignRelationResult {
  dryRun: boolean;
  assigned: Array<{ audienceId: string; role: "target" | "search"; outcome: "assigned" | "would_assign" | "already" }>;
}

export async function assignBrandRelation(input: AssignRelationInput): Promise<AssignRelationResult> {
  const { orgId, brandId, relation } = input;
  const ids = [...new Set([...(input.targetAudienceId ? [input.targetAudienceId] : []), ...input.searchAudienceIds])];
  if (ids.length === 0) throw new BrandRelationError("nothing to assign", 400);
  const rows = await db
    .select()
    .from(audiences)
    .where(and(eq(audiences.orgId, orgId), eq(audiences.brandId, brandId), inArray(audiences.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new BrandRelationError(`audiences not in this org and brand: ${missing.join(", ")}`, 404);
  if (rows.some((r) => r.status === "deprecated")) throw new BrandRelationError("cannot assign a deprecated audience", 400);
  if (input.targetAudienceId && byId.get(input.targetAudienceId)!.role !== "target") {
    throw new BrandRelationError(`targetAudienceId ${input.targetAudienceId} is not a target audience`, 400);
  }
  const notSearch = input.searchAudienceIds.filter((id) => byId.get(id)!.role !== "search");
  if (notSearch.length) throw new BrandRelationError(`not brand lists (role 'search'): ${notSearch.join(", ")}`, 400);
  if (input.targetAudienceId) {
    const [other] = await db
      .select({ id: audiences.id })
      .from(audiences)
      .where(
        and(
          eq(audiences.orgId, orgId),
          eq(audiences.brandId, brandId),
          eq(audiences.role, "target"),
          eq(audiences.relation, relation),
          ne(audiences.status, "deprecated"),
          ne(audiences.id, input.targetAudienceId)
        )
      );
    if (other) throw new BrandRelationError(`the brand already has its ${relation} audience: ${other.id}`, 409);
  }

  return db.transaction(async (tx) => {
    const result: AssignRelationResult = { dryRun: input.dryRun, assigned: [] };
    for (const id of ids) {
      const row = byId.get(id)!;
      const role = row.role as "target" | "search";
      if (row.relation === relation && row.offerId === null) {
        result.assigned.push({ audienceId: id, role, outcome: "already" });
        continue;
      }
      if (input.dryRun) {
        result.assigned.push({ audienceId: id, role, outcome: "would_assign" });
        continue;
      }
      await tx.update(audiences).set({ relation, offerId: null, updatedAt: new Date() }).where(eq(audiences.id, id));
      await tx
        .insert(brandRelationAssignments)
        .values({
          reason: input.reason,
          orgId,
          brandId,
          audienceId: id,
          relation,
          action: role === "target" ? "target_assigned" : "search_assigned",
          previousRelation: row.relation ?? null,
          previousRole: row.role ?? null,
          previousOfferId: row.offerId ?? null,
        })
        .onConflictDoNothing();
      result.assigned.push({ audienceId: id, role, outcome: "assigned" });
    }
    console.log(
      `[human-service] brand_relation.assign org=${orgId} brand=${brandId} relation=${relation} reason=${input.reason} dryRun=${input.dryRun} rows=${result.assigned.length}`
    );
    return result;
  });
}

/** Undo one assignment (by reason): relation, role and offer restored verbatim; rows `ensure` created are deprecated. */
export async function revertBrandRelation(reason: string): Promise<{ restored: number; deprecated: number }> {
  return db.transaction(async (tx) => {
    const ledger = await tx.select().from(brandRelationAssignments).where(eq(brandRelationAssignments.reason, reason));
    let restored = 0;
    let deprecated = 0;
    for (const row of ledger) {
      if (row.action === "target_created" || row.action === "search_created") {
        await tx.update(audiences).set({ status: "deprecated", updatedAt: new Date(), ...systemStatus("brand_relation") }).where(eq(audiences.id, row.audienceId));
        deprecated += 1;
        continue;
      }
      await tx
        .update(audiences)
        .set({
          relation: (row.previousRelation as BrandRelation | null) ?? null,
          role: (row.previousRole as AudienceRow["role"]) ?? null,
          offerId: row.previousOfferId,
          updatedAt: new Date(),
        })
        .where(eq(audiences.id, row.audienceId));
      restored += 1;
    }
    await tx.delete(brandRelationAssignments).where(eq(brandRelationAssignments.reason, reason));
    console.log(`[human-service] brand_relation.revert reason=${reason} restored=${restored} deprecated=${deprecated}`);
    return { restored, deprecated };
  });
}

// ─── The relation screen of a list already built (OUTREACH-3WAYS-1121) ──────────────────────────────────────
//
// The walk judges each person as it reaches them (relation-fit.ts). This screens a relation's lists ahead of the
// walk and says how many pass: it pages each ACTIVE Apollo list of the relation through the free teaser search
// into the list's buffer (the walk reads that same buffer), then judges every buffered person (peers: per company,
// so a company is one question for all its people). `dryRun` searches and judges nothing: it reports from what is
// already buffered and judged. Org-billed (Jev) on its own run.

export interface RelationScreenSample {
  providerPersonId: string;
  title: string | null;
  company: string | null;
  domain: string | null;
  industry: string | null;
  yesProbability: number | null;
}

export interface RelationScreenReport {
  relation: BrandRelation;
  audienceId: string;
  dryRun: boolean;
  lists: Array<{ audienceId: string; name: string; pagesSearched: number; buffered: number }>;
  people: number;
  judged: number;
  passed: number;
  failed: number;
  noFacts: number;
  unjudged: number;
  subjects: number;
  passedSubjects: number;
  passedSample: RelationScreenSample[];
  failedSample: RelationScreenSample[];
}

const SCREEN_MAX_PAGES = 50;
const SCREEN_CONCURRENCY = 8;

export async function screenRelationLists(input: {
  orgId: string;
  brandId: string;
  relation: BrandRelation;
  dryRun: boolean;
  maxPages?: number;
}): Promise<RelationScreenReport> {
  const { orgId, brandId, relation, dryRun } = input;
  const [target] = await db
    .select()
    .from(audiences)
    .where(
      and(
        eq(audiences.orgId, orgId),
        eq(audiences.brandId, brandId),
        eq(audiences.relation, relation),
        eq(audiences.role, "target"),
        ne(audiences.status, "deprecated")
      )
    )
    .limit(1);
  if (!target) throw new BrandRelationError(`the brand has no ${relation} audience`, 404);
  const lists = (
    await db
      .select()
      .from(audiences)
      .where(
        and(
          eq(audiences.orgId, orgId),
          eq(audiences.brandId, brandId),
          eq(audiences.relation, relation),
          eq(audiences.role, "search"),
          eq(audiences.status, "active"),
          eq(audiences.provider, "apollo")
        )
      )
  ).filter((l) => !!l.filters && Object.keys(l.filters as Record<string, unknown>).length > 0);

  const report: RelationScreenReport = {
    relation,
    audienceId: target.id,
    dryRun,
    lists: [],
    people: 0,
    judged: 0,
    passed: 0,
    failed: 0,
    noFacts: 0,
    unjudged: 0,
    subjects: 0,
    passedSubjects: 0,
    passedSample: [],
    failedSample: [],
  };
  // Billed to whoever created the relation audience, else one of its lists (an adopted target may carry no creator).
  const userId = target.createdByUserId ?? lists.find((l) => l.createdByUserId)?.createdByUserId ?? null;
  if (!dryRun && !userId) throw new BrandRelationError("the relation audience has no creator to bill the screen to", 400);

  const run = async (identity: Identity | null) => {
    for (const list of lists) {
      let pages = 0;
      if (identity) {
        const filters = list.filters as Record<string, unknown>;
        const native = hasApolloNativeFilters(list);
        const maxPages = input.maxPages ?? SCREEN_MAX_PAGES;
        while (pages < maxPages) {
          const search = await peopleSearch({
            provider: "apollo",
            filters: native ? {} : (filters as PeopleSearchFilters),
            apolloSearchParams: native ? filters : undefined,
            audienceId: list.id,
            identity: { ...identity, brandIds: [brandId] },
          });
          pages += 1;
          if (search.people.length === 0) break;
          await bufferTeasers(orgId, list.id, search.people, null);
        }
      }
      const buffered = await db
        .select()
        .from(audienceTeaserBuffer)
        .where(and(eq(audienceTeaserBuffer.audienceId, list.id), isNull(audienceTeaserBuffer.sourceId)));
      report.lists.push({ audienceId: list.id, name: list.name, pagesSearched: pages, buffered: buffered.length });
      const subjects = new Map<string, boolean | null>();
      const queue = [...buffered];
      const worker = async () => {
        for (;;) {
          const b = queue.shift();
          if (!b) return;
          report.people += 1;
          const subjectIn = { providerPersonId: b.providerPersonId, teaser: b.teaser ?? null, organizationDomain: b.organizationDomain ?? null };
          const subject = relationFitSubject(relation, subjectIn);
          if (!subject) {
            report.noFacts += 1;
            continue;
          }
          let fits: boolean | null;
          let p: number | null = null;
          if (identity) {
            const fit = await judgeRelationFit(target, subjectIn, identity);
            fits = fit.fits;
            p = "yesProbability" in fit ? fit.yesProbability : null;
          } else {
            const stored = await readRelationFit(orgId, brandId, relation, subject.key);
            fits = stored ? stored.verdict : null;
            p = stored?.yesProbability ?? null;
          }
          subjects.set(subject.key, fits);
          if (fits === null) {
            report.unjudged += 1;
            continue;
          }
          report.judged += 1;
          const sample: RelationScreenSample = {
            providerPersonId: b.providerPersonId,
            title: b.teaser?.title ?? null,
            company: b.teaser?.organizationName ?? null,
            domain: b.organizationDomain ?? null,
            industry: b.teaser?.organizationIndustry ?? null,
            yesProbability: p,
          };
          if (fits) {
            report.passed += 1;
            if (report.passedSample.length < 20) report.passedSample.push(sample);
          } else {
            report.failed += 1;
            if (report.failedSample.length < 20) report.failedSample.push(sample);
          }
        }
      };
      await Promise.all(Array.from({ length: SCREEN_CONCURRENCY }, worker));
      report.subjects += subjects.size;
      report.passedSubjects += [...subjects.values()].filter((v) => v === true).length;
    }
  };

  if (dryRun) {
    await run(null);
  } else {
    const tracking = { brandIds: [brandId] };
    const runId = await createRun({ orgId, userId: userId!, taskName: "brand-relation-screen", workflowTracking: tracking });
    if (!runId) throw new BrandRelationError("runs-service did not open a run for the relation screen", 502);
    const runIdentity = { orgId, userId: userId!, workflowTracking: tracking };
    try {
      await run({ orgId, userId: userId!, runId, workflowTracking: tracking });
      await completeRun(runId, "completed", runIdentity);
    } catch (err) {
      await completeRun(runId, "failed", runIdentity);
      throw err;
    }
  }
  console.log(
    `[human-service] brand_relation.screened org=${orgId} brand=${brandId} relation=${relation} dryRun=${dryRun} people=${report.people} passed=${report.passed} failed=${report.failed} noFacts=${report.noFacts} unjudged=${report.unjudged} subjects=${report.subjects} passedSubjects=${report.passedSubjects}`
  );
  return report;
}
