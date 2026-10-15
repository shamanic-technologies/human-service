// The serving pipe's CRM STEP filter (CRM-WARM-NURTURE-1015, owner 2026-10-15).
//
// Who a step reaches is filtered ONLY by the pipe's play, never by a campaign or a
// per-brand list. A play on the "Your CRM contacts" pipe may state which funnel
// steps the person reached in the brand's own tools, e.g. `{reached:
// ["form_submission", "meeting_booked"], notReached: ["sale", "disqualified"]}`
// (warm contacts who never became clients). crm-service owns that vocabulary and
// that judgement: the filter is passed VERBATIM, top-level, on every CRM serve and
// still-fits question, where crm-service ANDs it with the audience's own pool
// filter. Never validated here (a refused filter is crm-service's 400, relayed).
//
// A search provider (apollo / apify) knows nothing of the brand's funnel, so a
// serve stating a step filter for such an audience is REFUSED, never served
// unfiltered. Absent = today's serve, no key on any wire.
export type StepFilter = Record<string, unknown>;
