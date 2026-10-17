// Client tools whose own record id can name a human (HUMAN-RECORD-KEYS-1017):
// a person a brand knows ONLY as a record in its CRM / billing / analytics /
// auth tool (a name, no email, no phone). Kept dependency-free so schemas.ts
// publishes it as an OpenAPI enum. Add a provider here when a new connector
// states record keys.
export const CRM_RECORD_PROVIDERS = ["gohighlevel", "stripe", "posthog", "clerk"] as const;
export type CrmRecordProvider = (typeof CRM_RECORD_PROVIDERS)[number];
