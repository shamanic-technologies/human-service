// ONE-TIME MERGE of per-source audience rows into their profile's sources
// (AUDIENCE-SOURCES-1016, owner 2026-10-16: "the SOURCES should be a concept
// separate from TARGETING").
//
// Before, every (profile, source) pair was an audience row of its own:
// "<profile> (Hiring now)", "<profile> (Engaged with competitor posts)", carrying
// `profile_audience_id`. Every consumer listing audiences saw ~3x the targets
// (Doc Dinners 2026-10-16: 44 active = 14 targets + 27 per-source rows + 3).
//
// For each such child row (profile_audience_id set, not deprecated):
//   - a SOURCE of its profile is written (audience_sources), keeping the child's
//     Apollo pointer, filters, counts, reachable ceiling and on/off status;
//   - the child is marked `deprecated` with canonical_audience_id = its profile
//     (the existing merge mechanism): its members, candidates, screenings and
//     serves stay attached to it, and every read resolves it to the profile;
//   - its buffered teasers move to the profile under the new source, its
//     rejections are copied to the profile (same text judged them), and its
//     members are recorded as found by that source (per-source provenance);
//   - a profile a source campaign OFF paused (its own list off) while this child
//     ran resumes, running through the source as the child did.
// Nothing is archived or deleted (owner 2026-10-16). Idempotent (a merged child
// is deprecated, so a re-run moves 0), `dryRun` writes nothing, and `/revert`
// restores each child exactly from the `audience_source_merges` ledger.

import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  audienceSourceMerges,
  audienceSources,
  audiences,
  sourceCampaignAudienceHolds,
} from "../db/schema.js";
import { audienceListKind } from "./audience-snapshot.js";
import { sourceKeyOf, SIGNAL_NAMES } from "./profile-sources.js";
import { COMPETITOR_ENGAGEMENT_NAME } from "./competitor-engagement-audience.js";
import { isSystemResumable, systemStatus } from "./audience-status-origin.js";
import type { BuyingSignalType } from "../lib/apollo-audiences.js";

type AudienceRow = typeof audiences.$inferSelect;

export interface MergeMove {
  childAudienceId: string;
  childName: string;
  targetAudienceId: string;
  targetName: string;
  list: string;
  signalType: string | null;
  status: string;
  sourceId: string | null;
}

export interface MergeSkip {
  childAudienceId: string;
  childName: string;
  reason: "profile_missing" | "profile_deprecated" | "not_a_source_list" | "profile_has_source";
}

export interface MergeResult {
  dryRun: boolean;
  scanned: number;
  moved: number;
  archived: 0;
  moves: MergeMove[];
  skipped: MergeSkip[];
}

function windowDaysOf(filters: unknown): number | null {
  const s = (filters as Record<string, unknown> | null)?.buying_signal as Record<string, unknown> | undefined;
  return typeof s?.window_days === "number" ? s.window_days : null;
}

function sourceStatusOf(status: string): "active" | "paused" | "archived" {
  if (status === "active") return "active";
  if (status === "archived") return "archived";
  return "paused";
}

export async function mergeSourceAudiences(opts: {
  dryRun: boolean;
  orgId?: string;
  brandId?: string;
}): Promise<MergeResult> {
  const children = await db
    .select()
    .from(audiences)
    .where(
      and(
        isNotNull(audiences.profileAudienceId),
        ne(audiences.status, "deprecated"),
        ...(opts.orgId ? [eq(audiences.orgId, opts.orgId)] : []),
        ...(opts.brandId ? [eq(audiences.brandId, opts.brandId)] : [])
      )
    )
    .orderBy(audiences.createdAt);
  const result: MergeResult = { dryRun: opts.dryRun, scanned: children.length, moved: 0, archived: 0, moves: [], skipped: [] };

  for (const child of children) {
    const skip = (reason: MergeSkip["reason"]) =>
      result.skipped.push({ childAudienceId: child.id, childName: child.name, reason });
    const [target] = await db
      .select()
      .from(audiences)
      .where(and(eq(audiences.id, child.profileAudienceId!), eq(audiences.orgId, child.orgId)));
    if (!target) {
      skip("profile_missing");
      continue;
    }
    if (target.status === "deprecated") {
      skip("profile_deprecated");
      continue;
    }
    const key = sourceKeyOf(child);
    const list = audienceListKind(child);
    if (!key || (list !== "apollo_buying_signal" && list !== "linkedin_engagement")) {
      skip("not_a_source_list");
      continue;
    }
    const signalType = key === "linkedin_engagement" ? null : key;
    const [clash] = await db
      .select({ id: audienceSources.id })
      .from(audienceSources)
      .where(
        and(
          eq(audienceSources.audienceId, target.id),
          eq(audienceSources.list, list),
          signalType ? eq(audienceSources.signalType, signalType) : isNull(audienceSources.signalType)
        )
      );
    if (clash) {
      skip("profile_has_source");
      continue;
    }
    const move: MergeMove = {
      childAudienceId: child.id,
      childName: child.name,
      targetAudienceId: target.id,
      targetName: target.name,
      list,
      signalType,
      status: sourceStatusOf(child.status),
      sourceId: null,
    };
    if (!opts.dryRun) move.sourceId = await mergeOne(child, target, list, signalType);
    result.moves.push(move);
    result.moved++;
  }
  console.log(
    `[human-service] source_audience_merge${opts.dryRun ? "_dry_run" : ""} scanned=${result.scanned} moved=${result.moved} skipped=${result.skipped.length}`
  );
  return result;
}

async function mergeOne(
  child: AudienceRow,
  target: AudienceRow,
  list: "apollo_buying_signal" | "linkedin_engagement",
  signalType: string | null
): Promise<string> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const status = sourceStatusOf(child.status);
    const [source] = await tx
      .insert(audienceSources)
      .values({
        orgId: target.orgId,
        brandId: target.brandId,
        offerId: target.offerId,
        audienceId: target.id,
        list,
        signalType,
        windowDays: windowDaysOf(child.filters),
        name: signalType ? SIGNAL_NAMES[signalType as BuyingSignalType] ?? signalType : COMPETITOR_ENGAGEMENT_NAME,
        apolloAudienceId: child.apolloAudienceId,
        filters: child.filters,
        apolloCount: child.apolloCount,
        countedAt: child.countedAt,
        reachableCount: child.reachableCount,
        status,
        statusReason: "merged",
        statusSetAt: now,
        legacyAudienceId: child.id,
        createdByUserId: child.createdByUserId,
      })
      .returning();
    await tx
      .update(audiences)
      .set({ status: "deprecated", canonicalAudienceId: target.id, updatedAt: now, ...systemStatus("merged_into_audience") })
      .where(eq(audiences.id, child.id));

    const moved = (await tx.execute(sql`
      with ins as (
        insert into audience_teaser_buffer (org_id, audience_id, provider_person_id, linkedin_url, teaser, organization_domain, source_id, created_at)
        select org_id, ${target.id}::uuid, provider_person_id, linkedin_url, teaser, organization_domain, ${source.id}::uuid, created_at
          from audience_teaser_buffer where audience_id = ${child.id}
        on conflict do nothing
        returning 1
      )
      select count(*)::int as n from ins
    `)) as unknown as Array<{ n: number }>;
    await tx.execute(sql`delete from audience_teaser_buffer where audience_id = ${child.id}`);
    const copied = (await tx.execute(sql`
      with ins as (
        insert into audience_screened_out (org_id, audience_id, provider_person_id, linkedin_url, reason, screened_at)
        select org_id, ${target.id}::uuid, provider_person_id, linkedin_url,
               ${`merged_from:${child.id}: `} || coalesce(reason, ''), screened_at
          from audience_screened_out where audience_id = ${child.id}
        on conflict do nothing
        returning 1
      )
      select count(*)::int as n from ins
    `)) as unknown as Array<{ n: number }>;
    await tx.execute(sql`
      insert into audience_member_sources (org_id, audience_id, person_id, source_id, provenance, first_found_at, last_found_at)
      select org_id, ${target.id}::uuid, person_id, ${source.id}::uuid, provenance, joined_at, last_served_at
        from audience_members where audience_id = ${child.id}
      on conflict do nothing
    `);

    // The child ran while its profile's own list was off: the profile runs through
    // the source now, exactly as the child did.
    let targetResumed = false;
    let releasedHoldIds: string[] = [];
    const [fresh] = await tx.select().from(audiences).where(eq(audiences.id, target.id));
    if (status === "active" && fresh && isSystemResumable(fresh) && fresh.statusSetReason === "source_campaign_off") {
      await tx
        .update(audiences)
        .set({ status: "active", updatedAt: now, ...systemStatus("source_campaign_on") })
        .where(eq(audiences.id, target.id));
      releasedHoldIds = (
        await tx
          .update(sourceCampaignAudienceHolds)
          .set({ releasedAt: now })
          .where(and(eq(sourceCampaignAudienceHolds.audienceId, target.id), isNull(sourceCampaignAudienceHolds.releasedAt)))
          .returning({ id: sourceCampaignAudienceHolds.id })
      ).map((h) => h.id);
      targetResumed = true;
    }

    await tx.insert(audienceSourceMerges).values({
      childAudienceId: child.id,
      orgId: child.orgId,
      brandId: child.brandId,
      targetAudienceId: target.id,
      sourceId: source.id,
      priorStatus: child.status,
      priorStatusSetBy: child.statusSetBy,
      priorStatusSetReason: child.statusSetReason,
      priorStatusSetByUserId: child.statusSetByUserId,
      priorStatusSetAt: child.statusSetAt,
      priorCanonicalAudienceId: child.canonicalAudienceId,
      movedBuffer: moved[0]?.n ?? 0,
      copiedScreenedOut: copied[0]?.n ?? 0,
      targetResumed,
      releasedHoldIds,
    });
    console.log(
      `[human-service] source_audience_merge.moved org=${child.orgId} brand=${child.brandId} child=${child.id} target=${target.id} source=${source.id} list=${list} signal=${signalType ?? "-"} status=${status} buffer=${moved[0]?.n ?? 0} screenedOut=${copied[0]?.n ?? 0} targetResumed=${targetResumed}`
    );
    return source.id;
  });
}

export interface RevertMergeResult {
  dryRun: boolean;
  reverted: number;
  children: string[];
}

/** Undo the merge for every ledger row in scope: each child back to exactly what it was. */
export async function revertSourceAudienceMerge(opts: {
  dryRun: boolean;
  orgId?: string;
  brandId?: string;
}): Promise<RevertMergeResult> {
  const rows = await db
    .select()
    .from(audienceSourceMerges)
    .where(
      and(
        ...(opts.orgId ? [eq(audienceSourceMerges.orgId, opts.orgId)] : []),
        ...(opts.brandId ? [eq(audienceSourceMerges.brandId, opts.brandId)] : [])
      )
    );
  const result: RevertMergeResult = { dryRun: opts.dryRun, reverted: 0, children: [] };
  for (const m of rows) {
    result.children.push(m.childAudienceId);
    result.reverted++;
    if (opts.dryRun) continue;
    await db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(audiences)
        .set({
          status: m.priorStatus,
          statusSetBy: m.priorStatusSetBy,
          statusSetReason: m.priorStatusSetReason,
          statusSetByUserId: m.priorStatusSetByUserId,
          statusSetAt: m.priorStatusSetAt,
          canonicalAudienceId: m.priorCanonicalAudienceId,
          updatedAt: now,
        })
        .where(eq(audiences.id, m.childAudienceId));
      await tx.execute(sql`
        update audience_teaser_buffer set audience_id = ${m.childAudienceId}::uuid, source_id = null
         where source_id = ${m.sourceId}::uuid
           and not exists (select 1 from audience_teaser_buffer b2
                            where b2.audience_id = ${m.childAudienceId}::uuid
                              and b2.provider_person_id = audience_teaser_buffer.provider_person_id)
      `);
      await tx.execute(sql`delete from audience_teaser_buffer where source_id = ${m.sourceId}::uuid`);
      await tx.execute(sql`
        delete from audience_screened_out
         where audience_id = ${m.targetAudienceId}::uuid and reason like ${`merged_from:${m.childAudienceId}: %`}
      `);
      await tx.execute(sql`delete from audience_member_sources where source_id = ${m.sourceId}::uuid`);
      await tx.delete(audienceSources).where(eq(audienceSources.id, m.sourceId));
      if (m.targetResumed) {
        const [target] = await tx.select().from(audiences).where(eq(audiences.id, m.targetAudienceId));
        if (target && target.status === "active" && target.statusSetReason === "source_campaign_on") {
          await tx
            .update(audiences)
            .set({ status: "paused", updatedAt: now, ...systemStatus("source_campaign_off") })
            .where(eq(audiences.id, target.id));
          for (const holdId of m.releasedHoldIds ?? []) {
            await tx.execute(sql`
              update source_campaign_audience_holds set released_at = null
               where id = ${holdId}::uuid
                 and not exists (select 1 from source_campaign_audience_holds h2
                                  where h2.audience_id = ${m.targetAudienceId}::uuid and h2.released_at is null)
            `);
          }
        }
      }
      await tx.delete(audienceSourceMerges).where(eq(audienceSourceMerges.childAudienceId, m.childAudienceId));
    });
    console.log(
      `[human-service] source_audience_merge.reverted child=${m.childAudienceId} target=${m.targetAudienceId} source=${m.sourceId}`
    );
  }
  return result;
}
