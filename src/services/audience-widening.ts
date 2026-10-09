// Audience WIDENING proposals: the client's decision on the refill's "nothing
// left inside your target" (src/services/audience-refill.ts, owner rule
// 2026-10-04). The refill stores a pending proposal (the wider target + the
// segments it would add); a consumer reads it and accepts or declines it on the
// client's behalf.
//
//   - ACCEPT: the segments become ACTIVE audiences under the offer, all or
//     nothing, carrying the proposal's `widenedTarget` as `nl_prompt` (so the
//     target widens: the refill reads the newest validated target, and these
//     rows are tagged `widening_accepted`). Same insert as a split confirm, in
//     the SAME transaction that locks the proposal row, so two accepts can never
//     create the audiences twice. Then each row's Apollo build and own text in
//     the background, org-billed (same as a human confirm). Existing audiences
//     are never edited.
//   - DECLINE: only the proposal's status changes. A declined target is never
//     re-proposed by the refill.
//
// Both are idempotent: accepting an accepted proposal returns the audiences it
// created; declining a declined one returns it unchanged. The opposite decision
// on a decided proposal is a conflict (409).

import { ensureProfileAvatar } from "./audience-avatar.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences, audienceWideningProposals } from "../db/schema.js";
import { insertSplitAudiences } from "./audience-split.js";
import {
  dedupeSegmentNames,
  toWideningProposalView,
  WIDENING_ACCEPTED_SOURCE,
  type WideningProposalView,
} from "./audience-refill.js";
import { ensureApolloPointer } from "./audiences.js";
import { ensureTargetText } from "./audience-target-text.js";

type AudienceRow = typeof audiences.$inferSelect;
type Status = WideningProposalView["status"];

export class WideningProposalNotFoundError extends Error {
  constructor(id: string) {
    super(`Widening proposal ${id} not found for this org.`);
    this.name = "WideningProposalNotFoundError";
  }
}

export class WideningProposalConflictError extends Error {
  constructor(public readonly status: Status, attempted: "accept" | "decline") {
    super(`Widening proposal is already ${status}; it cannot be ${attempted === "accept" ? "accepted" : "declined"}.`);
    this.name = "WideningProposalConflictError";
  }
}

export async function listWideningProposals(args: {
  orgId: string;
  brandId?: string;
  status?: Status;
}): Promise<WideningProposalView[]> {
  const rows = await db
    .select()
    .from(audienceWideningProposals)
    .where(
      and(
        eq(audienceWideningProposals.orgId, args.orgId),
        ...(args.brandId ? [eq(audienceWideningProposals.brandId, args.brandId)] : []),
        ...(args.status ? [eq(audienceWideningProposals.status, args.status)] : [])
      )
    )
    .orderBy(desc(audienceWideningProposals.createdAt))
    .limit(100);
  return rows.map(toWideningProposalView);
}

export async function getWideningProposal(orgId: string, id: string): Promise<WideningProposalView> {
  const [row] = await db
    .select()
    .from(audienceWideningProposals)
    .where(and(eq(audienceWideningProposals.orgId, orgId), eq(audienceWideningProposals.id, id)))
    .limit(1);
  if (!row) throw new WideningProposalNotFoundError(id);
  return toWideningProposalView(row);
}

export async function acceptWideningProposal(args: {
  orgId: string;
  id: string;
  /** Who decided (the client, through the consumer). Recorded, never billed:
   * builds run under the user the refill ran under unless this is a UUID. */
  decidedByUserId: string | null;
}): Promise<{ proposal: WideningProposalView; audiences: AudienceRow[] }> {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(audienceWideningProposals)
      .where(and(eq(audienceWideningProposals.orgId, args.orgId), eq(audienceWideningProposals.id, args.id)))
      .for("update")
      .limit(1);
    if (!row) throw new WideningProposalNotFoundError(args.id);
    if (row.status === "declined") throw new WideningProposalConflictError("declined", "accept");
    if (row.status === "accepted") {
      const ids = row.createdAudienceIds ?? [];
      const existing = ids.length
        ? await tx.select().from(audiences).where(inArray(audiences.id, ids))
        : [];
      const order = new Map(ids.map((id, i) => [id, i]));
      existing.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return { row, created: existing, fresh: false };
    }
    const userId = isUuid(args.decidedByUserId) ? args.decidedByUserId : row.createdByUserId;
    // Names taken since the proposal was stored still collide: re-dedupe.
    const taken = await tx
      .select({ name: audiences.name })
      .from(audiences)
      .where(
        and(
          eq(audiences.orgId, row.orgId),
          eq(audiences.brandId, row.brandId),
          eq(audiences.offerId, row.offerId)
        )
      );
    const names = dedupeSegmentNames(
      row.segments.map((s) => s.name),
      taken.map((t) => t.name)
    );
    const created = await insertSplitAudiences(tx, {
      orgId: row.orgId,
      userId,
      brandId: row.brandId,
      offerId: row.offerId,
      targetAudience: row.widenedTarget,
      segments: row.segments.map((s, i) => ({ name: names[i], description: s.description })),
      source: WIDENING_ACCEPTED_SOURCE,
    });
    const [updated] = await tx
      .update(audienceWideningProposals)
      .set({
        status: "accepted",
        decidedAt: new Date(),
        decidedByUserId: args.decidedByUserId,
        createdAudienceIds: created.map((c) => c.id),
        updatedAt: new Date(),
      })
      .where(eq(audienceWideningProposals.id, row.id))
      .returning();
    return { row: updated, created, fresh: true, userId };
  });

  if (result.fresh) {
    const identity = { orgId: args.orgId, ...(result.userId ? { userId: result.userId } : {}) };
    for (const row of result.created) {
      void ensureTargetText(row, identity).catch((err) =>
        console.error(`[human-service] audience_widening.target_text.failed org=${args.orgId} audience=${row.id}`, err)
      );
      void ensureApolloPointer(row, identity).catch((err) =>
        console.error(`[human-service] audience_widening.pointer_build.failed org=${args.orgId} audience=${row.id}`, err)
      );
      void ensureProfileAvatar(row, identity).catch((err) =>
        console.error(`[human-service] audience_widening.avatar_failed org=${args.orgId} audience=${row.id}`, err)
      );
    }
    console.log(
      `[human-service] audience_widening.accepted org=${args.orgId} brand=${result.row.brandId} proposal=${result.row.id} created=${result.created.length}`
    );
  }
  return { proposal: toWideningProposalView(result.row), audiences: result.created };
}

export async function declineWideningProposal(args: {
  orgId: string;
  id: string;
  decidedByUserId: string | null;
}): Promise<WideningProposalView> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(audienceWideningProposals)
      .where(and(eq(audienceWideningProposals.orgId, args.orgId), eq(audienceWideningProposals.id, args.id)))
      .for("update")
      .limit(1);
    if (!row) throw new WideningProposalNotFoundError(args.id);
    if (row.status === "accepted") throw new WideningProposalConflictError("accepted", "decline");
    if (row.status === "declined") return toWideningProposalView(row);
    const [updated] = await tx
      .update(audienceWideningProposals)
      .set({ status: "declined", decidedAt: new Date(), decidedByUserId: args.decidedByUserId, updatedAt: new Date() })
      .where(eq(audienceWideningProposals.id, row.id))
      .returning();
    console.log(
      `[human-service] audience_widening.declined org=${args.orgId} brand=${row.brandId} proposal=${row.id}`
    );
    return toWideningProposalView(updated);
  });
}

function isUuid(v: string | null): v is string {
  return !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
