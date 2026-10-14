// The serving pipe's RELATIONSHIP policy (RELATIONSHIP-TAGS-1014, owner 2026-10-14).
//
// Who a pipe skips is the pipe's strategy, never a campaign rule. A play on the
// "Your CRM contacts" pipe may state `relationships: "business_only"`: nobody the
// brand knows as personal, investor, supplier, team, partner or advisor (tags
// owned by lead-service) is handed out. The CRM person is picked AND burned by
// crm-service, so the policy is pushed down to its serve, which decides; a person
// refused for that reason is not marked served there. For a provider audience
// (strangers found by apollo / apify) the policy changes nothing: nobody there has
// a relationship with the brand yet.
//
// Absent = today's serve, no key on any wire.
export const RELATIONSHIP_POLICIES = ["business_only"] as const;
export type RelationshipPolicy = (typeof RELATIONSHIP_POLICIES)[number];
