// serve-next apollo free-teaser drain buffer.
//
// Apollo's POST /search/next returns up to 100 FREE teasers per page AND advances
// its server-side cursor a whole page. serve-next reveals ONE lead per call, so
// without buffering the other ~99 teasers per page were discarded and the
// forward-only cursor moved on for good — capping an apollo audience at ~1 served
// lead per page (~1% of its verified-email pool). This buffer drains a page
// ACROSS serve-next calls: one fetch fills the buffer with a page's teasers; each
// serve-next pops ONE; apollo's cursor only re-advances when the buffer is empty.
// Raises the servable cap to ~100% of the pool.
//
// Bounded (≤ one apollo page per audience in flight), self-draining (popped on
// read — no cron). Rows cascade-delete with their audience.

import { db, sql as pg } from "../db/index.js";
import { audienceTeaserBuffer, type TeaserSnapshot } from "../db/schema.js";
import { findScreenedOut, toTeaserSnapshot } from "./teaser-screening.js";
import type { Person } from "./people-providers.js";

// A buffered teaser carries what the pop path needs and cannot re-derive: the
// apollo person id (enrich handle), the raw linkedin url (pre-pay suppression
// re-check) and the snapshot the pre-pay screen judges. The snapshot is stored
// rather than re-fetched because the Person object is in hand HERE and apollo's
// cursor has moved on by the time the teaser is popped.
export interface BufferedTeaser {
  providerPersonId: string;
  linkedinUrl: string | null;
  // NULL on rows buffered before screening shipped — there is nothing to judge,
  // so those serve unscreened (counted + logged in screenTeaser).
  teaser: TeaserSnapshot | null;
  // Employer web domain as the provider served it (null when none). Not part of
  // the screened snapshot; read by the candidate API only.
  organizationDomain: string | null;
}

// Enqueue a fetched apollo page's free teasers for later draining. Idempotent on
// (audience_id, provider_person_id) — a teaser already buffered (or re-surfaced
// by a concurrent double-fetch) is ignored. Teasers without a providerPersonId
// (no enrich handle) are dropped. Returns how many NEW teasers were enqueued.
export async function bufferTeasers(
  orgId: string,
  audienceId: string,
  teasers: Person[],
  // The audience source whose search found them (null = the audience's own list).
  sourceId: string | null = null
): Promise<number> {
  const withHandle = teasers.filter((t) => t.providerPersonId);
  // Drop the people this audience's screen already rejected, so a rejected
  // person is never re-buffered and never re-screened. One query per page.
  const screenedOut = await findScreenedOut(
    audienceId,
    withHandle.map((t) => t.providerPersonId as string)
  );
  const rows = withHandle
    .filter((t) => !screenedOut.has(t.providerPersonId as string))
    .map((t) => ({
      orgId,
      audienceId,
      providerPersonId: t.providerPersonId as string,
      linkedinUrl: t.linkedinUrl,
      teaser: toTeaserSnapshot(t),
      organizationDomain: t.organization?.domain ?? null,
      sourceId,
    }));
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(audienceTeaserBuffer)
    .values(rows)
    .onConflictDoNothing({
      target: [
        audienceTeaserBuffer.audienceId,
        audienceTeaserBuffer.providerPersonId,
      ],
    })
    .returning({ id: audienceTeaserBuffer.id });
  return inserted.length;
}

// Atomically pop the oldest buffered teaser for an audience, or null when the
// buffer is empty. DELETE ... RETURNING with FOR UPDATE SKIP LOCKED so concurrent
// serve-next calls never pop the same row (and a locked row is skipped, not
// blocked on). Uses the raw postgres.js client for the locking subquery.
export async function popTeaser(
  orgId: string,
  audienceId: string,
  // Each source drains its own teasers (null = the audience's own list).
  sourceId: string | null = null
): Promise<BufferedTeaser | null> {
  const ofSource = sourceId ? pg`AND source_id = ${sourceId}` : pg`AND source_id IS NULL`;
  const rows = await pg<
    {
      provider_person_id: string;
      linkedin_url: string | null;
      teaser: TeaserSnapshot | null;
      organization_domain: string | null;
    }[]
  >`
    DELETE FROM audience_teaser_buffer
    WHERE id = (
      SELECT id FROM audience_teaser_buffer
      WHERE org_id = ${orgId} AND audience_id = ${audienceId} ${ofSource}
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING provider_person_id, linkedin_url, teaser, organization_domain
  `;
  const r = rows[0];
  return r
    ? {
        providerPersonId: r.provider_person_id,
        linkedinUrl: r.linkedin_url,
        teaser: r.teaser,
        organizationDomain: r.organization_domain,
      }
    : null;
}

// FACTORY-P3 next outcomes (lead_found): a popped teaser as its stored row, so a page the stored walk script
// popped but did not decide goes back EXACTLY where it was (same id, same created_at: the drain order is unchanged).
export interface PoppedTeaserRow extends BufferedTeaser {
  id: string;
  orgId: string;
  audienceId: string;
  sourceId: string | null;
  createdAt: Date;
}

export async function popTeaserRow(
  orgId: string,
  audienceId: string,
  sourceId: string | null = null
): Promise<PoppedTeaserRow | null> {
  const ofSource = sourceId ? pg`AND source_id = ${sourceId}` : pg`AND source_id IS NULL`;
  const rows = await pg<
    {
      id: string;
      org_id: string;
      audience_id: string;
      source_id: string | null;
      created_at: Date;
      provider_person_id: string;
      linkedin_url: string | null;
      teaser: TeaserSnapshot | null;
      organization_domain: string | null;
    }[]
  >`
    DELETE FROM audience_teaser_buffer
    WHERE id = (
      SELECT id FROM audience_teaser_buffer
      WHERE org_id = ${orgId} AND audience_id = ${audienceId} ${ofSource}
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, org_id, audience_id, source_id, created_at, provider_person_id, linkedin_url, teaser, organization_domain
  `;
  const r = rows[0];
  return r
    ? {
        id: r.id,
        orgId: r.org_id,
        audienceId: r.audience_id,
        sourceId: r.source_id,
        createdAt: new Date(r.created_at),
        providerPersonId: r.provider_person_id,
        linkedinUrl: r.linkedin_url,
        teaser: r.teaser,
        organizationDomain: r.organization_domain,
      }
    : null;
}

/** Put popped-but-undecided teasers back with their own id and created_at (a re-surfaced one is ignored). */
export async function restoreTeasers(rows: PoppedTeaserRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(audienceTeaserBuffer)
    .values(
      rows.map((r) => ({
        id: r.id,
        orgId: r.orgId,
        audienceId: r.audienceId,
        providerPersonId: r.providerPersonId,
        linkedinUrl: r.linkedinUrl,
        teaser: r.teaser,
        organizationDomain: r.organizationDomain,
        sourceId: r.sourceId,
        createdAt: r.createdAt,
      }))
    )
    .onConflictDoNothing();
}
