// Messaging networks a human can be known by (RELATIONSHIP-TAGS-1014). Kept
// dependency-free so schemas.ts publishes it as an OpenAPI enum.
export const MESSAGING_NETWORKS = [
  "whatsapp",
  "linkedin",
  "telegram",
  "signal",
  "instagram",
  "messenger",
] as const;
export type MessagingNetwork = (typeof MESSAGING_NETWORKS)[number];
