// A linkedin_engagement signal audience: the people who recently reacted to or
// commented on a competitor company page's LinkedIn posts (apollo-service owns
// the criterion, the harvest, the no-repeat and the spend). Here it is a plain
// apollo POINTER audience whose stored filters are the opaque
// `{buying_signal: {type: "linkedin_engagement", ...}}` apollo-service returned,
// so serve-next forwards them verbatim to /search/next, screens each engager
// teaser with Jev before the paid reveal, and reads `done` as exhausted —
// exactly like every other apollo audience. What differs is only what does NOT
// exist for it: no Apollo count, dry-run or preview (see the guards on
// isLinkedinEngagementFilters across the count / preview / refill paths).

import { db } from "../db/index.js";
import { audiences, type Audience } from "../db/schema.js";
import { createApolloLinkedinEngagementAudience } from "../lib/apollo-audiences.js";
import type { Identity } from "./people-providers.js";
import { audienceTargetFields } from "./audience-target-text.js";

export const LINKEDIN_ENGAGEMENT_SOURCE = "linkedin_engagement_signal";

export async function createLinkedinEngagementAudience(args: {
  orgId: string;
  userId: string;
  brandId: string;
  offerId: string | null;
  name?: string;
  nlPrompt: string;
  status: "active" | "paused";
  windowDays: number;
  competitorPages: string[];
  baseFilters: Record<string, unknown>;
  /** The client profile this list is built for (profile-sources.ts); omitted = none. */
  profileAudienceId?: string;
  identity: Identity;
}): Promise<Audience> {
  const apollo = await createApolloLinkedinEngagementAudience({
    brandId: args.brandId,
    name: args.name,
    windowDays: args.windowDays,
    competitorPages: args.competitorPages,
    baseFilters: args.baseFilters,
    identity: args.identity,
  });
  const [row] = await db
    .insert(audiences)
    .values({
      orgId: args.orgId,
      brandId: args.brandId,
      offerId: args.offerId,
      name: args.name ?? apollo.name,
      description: apollo.description,
      // The pre-pay screen's target: who among the engagers is worth writing to.
      nlPrompt: args.nlPrompt,
      // The engagers are screened against the WHOLE target: the signal says how
      // the list is built, not who is wanted.
      ...audienceTargetFields(args.nlPrompt),
      provider: "apollo",
      apolloAudienceId: apollo.apolloAudienceId,
      filters: apollo.filters,
      // No Apollo count exists for this kind: the pool is unknown until a serve
      // walks it (reachable_count is persisted at exhaustion). Null, never 0.
      apolloCount: null,
      countedAt: null,
      status: args.status,
      source: LINKEDIN_ENGAGEMENT_SOURCE,
      profileAudienceId: args.profileAudienceId ?? null,
      createdByUserId: args.userId,
    })
    .returning();
  console.log(
    `[human-service] audience.linkedin_engagement_created org=${args.orgId} brand=${args.brandId} audience=${row.id} apollo=${apollo.apolloAudienceId} pages=${args.competitorPages.length}`
  );
  return row;
}
