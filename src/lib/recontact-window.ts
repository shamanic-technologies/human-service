// The per-brand re-contact window a serve asks for (FRESH-2-MONTHS-1027).
//
// A person served (or emailed: send-suppression-sync.ts moves the anchor to the
// send) for a brand is not handed out again for that brand inside the window.
// The window is 3 months unless the SERVE says otherwise: lead-service forwards
// its body field `excludeEmailedWithin` verbatim on serve-next, candidates/next
// and candidates/{id}/reveal, chosen by the calling workflow (one value per
// request, never per brand / campaign). `2_months` lets a market that is used up
// keep prospecting people emailed more than 2 months ago. Absent = `3_months` =
// today's serve, byte for byte.
//
// The internal jobs that are not a serve (send sync, backfill reporting, the
// audiences' Remaining rollup) keep the default window.

export const EXCLUDE_EMAILED_WITHIN = ["3_months", "2_months"] as const;
export type ExcludeEmailedWithin = (typeof EXCLUDE_EMAILED_WITHIN)[number];

export const DEFAULT_EXCLUDE_EMAILED_WITHIN: ExcludeEmailedWithin = "3_months";

// The Postgres interval literal of each window (calendar months).
export const WINDOW_INTERVAL: Record<ExcludeEmailedWithin, string> = {
  "3_months": "3 months",
  "2_months": "2 months",
};

// True only when the serve asked for a window SHORTER than the default: the one
// case where people this audience already served, lapsed under it, are walked
// again from what we hold (src/services/recontact-rereach.ts).
export function isShortenedWindow(w: ExcludeEmailedWithin | undefined): boolean {
  return w !== undefined && w !== DEFAULT_EXCLUDE_EMAILED_WITHIN;
}
