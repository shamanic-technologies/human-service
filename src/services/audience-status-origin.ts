// WHO set an audience's status (LEAK-1012, owner 2026-10-12): an audience a PERSON
// paused is never un-paused by a product path. Only that person's (or another
// person's) explicit act on THAT audience (PATCH /orgs/audiences/{id}/status)
// resumes it.
//
// Every status write states its origin (audiences.status_set_by, migration 0044):
//   person  an explicit act on this audience (PATCH /status, a create naming its status)
//   system  a product path (source campaign OFF, profile cascade, born paused, retirement)
//   NULL    not recorded (written before the column; a hold proved the rest system)
//
// Every AUTOMATIC resume goes through `systemResumable`: status paused AND set by the
// system. NULL counts as a person's pause: never auto-unpause what we cannot prove the
// system paused (a hold row the system owns was backfilled to 'system').

import { and, eq, inArray } from "drizzle-orm";
import { audiences } from "../db/schema.js";

export type StatusSetBy = "person" | "system";

/** Why the system set a status (stored verbatim in status_set_reason). */
export type SystemStatusReason =
  | "source_campaign_off" // a source campaign OFF paused (and held) it
  | "source_campaign_on" // a source campaign ON resumed a system pause
  | "profile_paused" // its client profile was paused (cascade)
  | "profile_resumed" // its client profile was resumed (cascade)
  | "born" // created by a product path in the status it was born in
  | "whole_icp_retired" // the whole-ICP list was retired once profiles had their lists
  | "portfolio_adopted" // a launch adopted a confirmed split
  | "merged_into_audience"; // a per-source list became a source of its profile (AUDIENCE-SOURCES-1016)

export function personStatus(userId: string | null | undefined) {
  return {
    statusSetBy: "person" as const,
    statusSetReason: "person",
    statusSetByUserId: userId ?? null,
    statusSetAt: new Date(),
  };
}

export function systemStatus(reason: SystemStatusReason) {
  return {
    statusSetBy: "system" as const,
    statusSetReason: reason,
    statusSetByUserId: null,
    statusSetAt: new Date(),
  };
}

/** True when an automatic path may resume this row: paused BY THE SYSTEM. */
export function isSystemResumable(row: { status: string; statusSetBy: string | null }): boolean {
  return row.status === "paused" && row.statusSetBy === "system";
}

/** The WHERE an automatic resume must carry (ids narrowed to system pauses). */
export function systemResumable(ids: string[]) {
  return and(inArray(audiences.id, ids), eq(audiences.status, "paused"), eq(audiences.statusSetBy, "system"));
}
