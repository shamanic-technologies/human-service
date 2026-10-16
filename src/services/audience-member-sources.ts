// Per-source provenance writer (AUDIENCE-SOURCES-1016, table audience_member_sources,
// migration 0047). Standalone (db only) so the membership writers in
// audiences.ts / audience-provenance.ts import it without an import cycle.

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Record that `sourceId` (null = the audience's own list) found `personId` for the
 * audience. 'served' wins over 'found_taken'. One row per (audience, person, source).
 */
export async function tagMemberSource(
  tx: Tx | typeof db,
  orgId: string,
  audienceId: string,
  personId: string,
  sourceId: string | null,
  provenance: "served" | "found_taken"
): Promise<void> {
  await tx.execute(sql`
    insert into audience_member_sources (org_id, audience_id, person_id, source_id, provenance)
    values (${orgId}, ${audienceId}, ${personId}, ${sourceId}, ${provenance})
    on conflict (audience_id, person_id, coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set last_found_at = now(),
      provenance = case when excluded.provenance = 'served' then 'served' else audience_member_sources.provenance end
  `);
}

