import { audiences } from "../db/schema.js";
import { buildAvatarPrompt, generateAvatar } from "./audiences.js";
import type { Identity } from "./people-providers.js";
import { isProfile } from "./profile-sources.js";

type AudienceRow = typeof audiences.$inferSelect;

// One in-flight generation per audience: the background call after a confirm and
// a status flip landing at the same moment never pay for two images.
const inFlight = new Map<string, Promise<void>>();

/**
 * Give an audience its avatar if it has none. Org-billed with the identity of the
 * request that caused it (chat-service owns the image cost), the same rule the
 * activation path has always used. A row that already has one is left alone, so
 * a re-run never re-bills. Errors propagate: callers fire it in the background
 * and log the failure.
 */
export function ensureAvatar(row: AudienceRow, identity: Identity): Promise<void> {
  if (row.avatarUrl) return Promise.resolve();
  const pending = inFlight.get(row.id);
  if (pending) return pending;
  const p = (async () => {
    await generateAvatar(row.orgId, row.id, buildAvatarPrompt(row), identity);
    console.log(`[human-service] audience.avatar_generated org=${row.orgId} audience=${row.id}`);
  })().finally(() => inFlight.delete(row.id));
  inFlight.set(row.id, p);
  return p;
}

/**
 * A client profile gets its avatar the moment it is born, whatever path created
 * it (split confirm, portfolio, refill, widening, source campaign). Source lists
 * built for a profile get none: the dashboard shows the profile's.
 */
export function ensureProfileAvatar(row: AudienceRow, identity: Identity): Promise<void> {
  if (!isProfile(row)) return Promise.resolve();
  return ensureAvatar(row, identity);
}
