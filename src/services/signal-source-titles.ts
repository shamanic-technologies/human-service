// HIRING-TITLES-1102 (2026-11-02): a hiring source can say WHICH roles are being
// hired. A test-automation vendor wants companies posting QA / SDET / Test
// Automation jobs, not companies hiring any role.
//
// apollo-service owns the criterion: `signal.jobTitles` on POST /audiences/signal
// narrows the search to employers with such a posting in the window and picks a
// posting naming one of them as the served person's signal fact. Here we only:
//   - add a buying-signal source to a profile, optionally titled (a caller asks);
//   - (re)state the titles of an existing hiring source: a NEW apollo-service
//     audience is built on the profile's own one with the titles, the source points
//     at it (new filters = a new apollo cursor), and the teasers buffered under the
//     old filters are dropped (they were found without the titles);
//   - new hiring sources of the offer built automatically inherit the titles
//     (profile-sources.ts `offerHiringJobTitles`).
// The titles live in the source's stored filters (`buying_signal.job_titles`,
// apollo-service's spelling), the one record of them; channels[].signal.jobTitles
// reads them back. No titles = any role, as before. Spends nothing: apollo-service's
// signal audience is a free count.

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences, audienceSources, audienceTeaserBuffer } from "../db/schema.js";
import { createApolloSignalAudience, readSignalJobTitles, type BuyingSignalType } from "../lib/apollo-audiences.js";
import { sourcesOf, type AudienceSource } from "./audience-sources.js";
import { createSignalSource, isProfile, readyProfile, SIGNAL_NAMES, SIGNAL_WINDOW_DAYS } from "./profile-sources.js";
import { sourcingOriginSlug } from "./sourcing-origin.js";
import type { Identity } from "./people-providers.js";

type AudienceRow = typeof audiences.$inferSelect;

export class SignalSourceRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
    readonly sourceId?: string
  ) {
    super(message);
    this.name = "SignalSourceRequestError";
  }
}

/** Trimmed, de-duplicated (case-insensitive), empty dropped; null when nothing is left. */
export function normalizeJobTitles(titles: string[] | null | undefined): string[] | null {
  if (!titles) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of titles) {
    const t = raw.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.length > 0 ? out : null;
}

async function loadProfile(orgId: string, audienceId: string): Promise<AudienceRow> {
  const [row] = await db
    .select()
    .from(audiences)
    .where(and(eq(audiences.id, audienceId), eq(audiences.orgId, orgId)));
  if (!row) throw new SignalSourceRequestError(404, "audience_not_found", "Audience not found");
  if (!isProfile(row) || !row.offerId) {
    throw new SignalSourceRequestError(
      400,
      "not_a_profile",
      "Buying-signal sources are added to a profile: an Apollo search audience of an offer (not a source list, a CRM or a LinkedIn engagement audience)."
    );
  }
  if (row.status === "archived") {
    throw new SignalSourceRequestError(400, "audience_archived", "The audience is archived.");
  }
  return row;
}

/** Add a buying-signal source to a profile (POST /orgs/audiences/{id}/sources). */
export async function addProfileSignalSource(input: {
  orgId: string;
  audienceId: string;
  type: BuyingSignalType;
  windowDays?: number;
  jobTitles?: string[] | null;
  userId: string;
  identity: Identity;
}): Promise<{ audience: AudienceRow; source: AudienceSource }> {
  const jobTitles = normalizeJobTitles(input.jobTitles);
  if (jobTitles && input.type !== "hiring") {
    throw new SignalSourceRequestError(400, "job_titles_hiring_only", "jobTitles is only valid for the hiring signal.");
  }
  const profile = await loadProfile(input.orgId, input.audienceId);
  const existing = ((await sourcesOf([profile.id])).get(profile.id) ?? []).find(
    (s) => s.list === "apollo_buying_signal" && s.signalType === input.type
  );
  if (existing) {
    throw new SignalSourceRequestError(
      409,
      "source_exists",
      `The audience already has a ${input.type} source (${existing.id}). Change its job titles with PATCH /orgs/audiences/${profile.id}/sources/${existing.id}.`,
      existing.id
    );
  }
  const scope = { orgId: profile.orgId, brandId: profile.brandId, offerId: profile.offerId! };
  const ready = await readyProfile(profile, input.identity);
  const source = await createSignalSource({
    scope,
    profile: ready.row,
    type: input.type,
    windowDays: input.windowDays ?? SIGNAL_WINDOW_DAYS[input.type],
    jobTitles,
    args: {
      userId: input.userId,
      identity: input.identity,
      // Born status = the Buying Signals source campaign's state for the offer.
      originSlug: await sourcingOriginSlug("apollo_buying_signal"),
    },
  });
  return { audience: ready.row, source };
}

/** (Re)state the posted job titles of a hiring source (PATCH /orgs/audiences/{id}/sources/{sourceId}). */
export async function setSourceJobTitles(input: {
  orgId: string;
  audienceId: string;
  sourceId: string;
  jobTitles: string[] | null;
  identity: Identity;
}): Promise<{ audience: AudienceRow; source: AudienceSource; changed: boolean }> {
  const jobTitles = normalizeJobTitles(input.jobTitles);
  const profile = await loadProfile(input.orgId, input.audienceId);
  const [source] = await db
    .select()
    .from(audienceSources)
    .where(and(eq(audienceSources.id, input.sourceId), eq(audienceSources.audienceId, profile.id)));
  if (!source) throw new SignalSourceRequestError(404, "source_not_found", "Source not found on this audience");
  if (source.list !== "apollo_buying_signal" || source.signalType !== "hiring") {
    throw new SignalSourceRequestError(
      400,
      "not_a_hiring_source",
      "Job titles narrow a hiring source only (posted jobs). This source is not one."
    );
  }
  const current = readSignalJobTitles(source.filters);
  if (JSON.stringify(current) === JSON.stringify(jobTitles)) {
    return { audience: profile, source, changed: false };
  }
  const ready = await readyProfile(profile, input.identity);
  const apollo = await createApolloSignalAudience({
    baseApolloAudienceId: ready.row.apolloAudienceId!,
    brandId: profile.brandId,
    name: `${profile.name} (${SIGNAL_NAMES.hiring})`,
    type: "hiring",
    windowDays: source.windowDays ?? SIGNAL_WINDOW_DAYS.hiring,
    jobTitles,
    identity: input.identity,
  });
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(audienceSources)
      .set({
        apolloAudienceId: apollo.apolloAudienceId,
        filters: apollo.filters,
        apolloCount: apollo.count,
        countedAt: now,
        // A new search: its size and exhaustion are learned again.
        reachableCount: null,
        exhaustedAt: null,
        updatedAt: now,
      })
      .where(eq(audienceSources.id, source.id))
      .returning();
    // Teasers found under the old filters may sit at companies not posting these roles.
    await tx.delete(audienceTeaserBuffer).where(eq(audienceTeaserBuffer.sourceId, source.id));
    return row;
  });
  console.log(
    `[human-service] audience_source.job_titles org=${profile.orgId} brand=${profile.brandId} audience=${profile.id} source=${source.id} from=${JSON.stringify(current)} to=${JSON.stringify(jobTitles)} apolloAudience=${apollo.apolloAudienceId} count=${apollo.count}`
  );
  return { audience: ready.row, source: updated, changed: true };
}
