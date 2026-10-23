// AUDIENCE SOURCES (AUDIENCE-SOURCES-1016, owner 2026-10-16): "the SOURCES should
// be a concept separate from TARGETING".
//
// An AUDIENCE is WHO we want: one target text ("chiro owners & co"). A SOURCE is
// WHERE we look for them: a buying signal (hiring / job_change / funding) or
// competitor-post engagement. A source is never an audience row: it is an
// `audience_sources` row BESIDE its audience. The audience's OWN list (its own
// Apollo filters / pointer, or its CRM file) is its first source and stays on the
// audience row; its on/off is `audiences.own_source_status`.
//
// SERVING. lead-service asks GET /orgs/audiences/{id}/sourcing-origin which origin
// to serve from, opens its serve run under that slug, and calls serve-next /
// candidates with it as x-feature-slug. So:
//   - sourcing-origin answers ONE of the audience's ON sources (own list on + every
//     active source), picked at random so each source gets its share;
//   - serve-next / candidates map the slug back to a list kind and serve from that
//     source of the audience (`pickServeSource`). Everything the serve writes
//     (teaser buffer, screen verdict, candidate, bronze serve, membership) is keyed
//     on the AUDIENCE and tagged with the source id. Screening always judges the
//     AUDIENCE's own text.
// An audience with no source keeps serving exactly as before (no catalogue read,
// no byte changed).
//
// ON/OFF. A source campaign OFF pauses the offer's source entries of its list (and
// marks the own list off for the audiences whose own list it is). An audience runs
// while at least one of its sources is ON: the last one going OFF pauses it (held,
// like before), the first one coming back resumes it, never a pause a PERSON made
// (LEAK-1012). No person writes a source. A paused audience is contacted through
// no source.

import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  audienceSources,
  audiences,
  sourceCampaignAudienceHolds,
  sourceCampaignStates,
  type AudienceSource,
} from "../db/schema.js";
import { audienceListKind } from "./audience-snapshot.js";
import { isCrmSourcedFeature, listKindOfOriginSlug, type AudienceListKind } from "./sourcing-origin.js";
import { isSystemResumable, systemStatus } from "./audience-status-origin.js";
export { tagMemberSource } from "./audience-member-sources.js";
import { LEAD_SOURCING_SLUG, readLeadSourcingChoice } from "./lead-sourcing.js";
import { pgErrorCode } from "../lib/pg-error.js";
import { noteListBuilt } from "./run-outputs.js";

type AudienceRow = typeof audiences.$inferSelect;

export type { AudienceSource };

/** A source walked out less than this ago is not picked while another ON source has people. */
export const SOURCE_EXHAUSTED_RETRY_MS = 24 * 60 * 60_000;

export interface OfferScope {
  orgId: string;
  brandId: string;
  offerId: string;
}

/** The sources of each audience (any status), oldest first. */
export async function sourcesOf(audienceIds: string[]): Promise<Map<string, AudienceSource[]>> {
  const out = new Map<string, AudienceSource[]>();
  if (audienceIds.length === 0) return out;
  const rows = await db
    .select()
    .from(audienceSources)
    .where(inArray(audienceSources.audienceId, [...new Set(audienceIds)]))
    .orderBy(audienceSources.createdAt);
  for (const r of rows) {
    const list = out.get(r.audienceId) ?? [];
    list.push(r);
    out.set(r.audienceId, list);
  }
  return out;
}

/** The offer's sources of one list kind (any status). */
export async function offerSources(scope: OfferScope, list?: AudienceListKind): Promise<AudienceSource[]> {
  return db
    .select()
    .from(audienceSources)
    .where(
      and(
        eq(audienceSources.orgId, scope.orgId),
        eq(audienceSources.brandId, scope.brandId),
        eq(audienceSources.offerId, scope.offerId),
        ...(list ? [eq(audienceSources.list, list)] : [])
      )
    )
    .orderBy(audienceSources.createdAt);
}

export function isSourceOn(s: Pick<AudienceSource, "status">): boolean {
  return s.status === "active";
}

export function ownListOn(a: Pick<AudienceRow, "ownSourceStatus">): boolean {
  return a.ownSourceStatus !== "paused";
}

function recentlyExhausted(s: Pick<AudienceSource, "exhaustedAt">, now = Date.now()): boolean {
  return !!s.exhaustedAt && now - s.exhaustedAt.getTime() < SOURCE_EXHAUSTED_RETRY_MS;
}

/** The source kind key: a buying-signal type, or "linkedin_engagement". */
export function sourceKind(s: Pick<AudienceSource, "list" | "signalType">): string {
  return s.list === "linkedin_engagement" ? "linkedin_engagement" : (s.signalType ?? s.list);
}

/**
 * The audience row as the serve machinery sees it when serving FROM a source: the
 * same audience (id, brand, text, status), the source's Apollo audience and count.
 */
export function sourceView(audience: AudienceRow, source: AudienceSource): AudienceRow {
  return {
    ...audience,
    provider: "apollo",
    apolloAudienceId: source.apolloAudienceId,
    filters: source.filters,
    apolloCount: source.apolloCount,
    countedAt: source.countedAt,
    reachableCount: source.reachableCount,
    crmUploadId: null,
    crmPeopleFilter: null,
  };
}

export type ServePick =
  | { kind: "own" }
  // In serve order. `null` = the audience's OWN list (a Lead Sourcing serve mixes both).
  | { kind: "sources"; sources: Array<AudienceSource | null> }
  | { kind: "off"; reason: string };

/**
 * Which source of the audience a serve under `featureSlug` draws from.
 *   - CRM-sourced feature, or an audience with no source ⟹ its own list (today).
 *   - the slug names a list the audience has sources of ⟹ those that are ON,
 *     the ones not walked out recently first, least recently served first; none
 *     ON (or the audience not active) ⟹ off: nothing served through it.
 *   - the slug names the audience's own list ⟹ own list, unless it is OFF while
 *     other sources run.
 *   - `lead-sourcing` (the channel that PICKS its origins, lead-sourcing.ts) ⟹ the
 *     own list when its origin is chosen and on, plus every ON source whose origin is
 *     chosen, in random order (each its share), the ones walked out recently last;
 *     nothing chosen ⟹ off. No stored choice ⟹ own list.
 *   - anything else (an outreach slug, an origin the audience has no source of)
 *     ⟹ its own list, exactly as before.
 */
export async function pickServeSource(
  audience: AudienceRow,
  featureSlug: string | undefined,
  random: () => number = Math.random
): Promise<ServePick> {
  if (isCrmSourcedFeature(featureSlug) || !featureSlug) return { kind: "own" };
  const sources = (await sourcesOf([audience.id])).get(audience.id) ?? [];
  if (sources.length === 0) return { kind: "own" };
  if (featureSlug === LEAD_SOURCING_SLUG) return pickLeadSourcing(audience, sources, random);
  const list = await listKindOfOriginSlug(featureSlug);
  if (!list) return { kind: "own" };
  const ofList = sources.filter((s) => s.list === list);
  if (ofList.length === 0) {
    if (list === audienceListKind(audience) && !ownListOn(audience)) {
      return { kind: "off", reason: `own ${list} list is off` };
    }
    return { kind: "own" };
  }
  if (audience.status !== "active") return { kind: "off", reason: `audience is ${audience.status}` };
  const on = ofList.filter(isSourceOn);
  if (on.length === 0) return { kind: "off", reason: `every ${list} source of the audience is off` };
  const now = Date.now();
  on.sort((a, b) => {
    const ea = recentlyExhausted(a, now) ? 1 : 0;
    const eb = recentlyExhausted(b, now) ? 1 : 0;
    if (ea !== eb) return ea - eb;
    return (a.lastServedAt?.getTime() ?? 0) - (b.lastServedAt?.getTime() ?? 0);
  });
  return { kind: "sources", sources: on };
}

async function pickLeadSourcing(
  audience: AudienceRow,
  sources: AudienceSource[],
  random: () => number
): Promise<ServePick> {
  if (!audience.offerId) return { kind: "own" };
  const choice = await readLeadSourcingChoice({ orgId: audience.orgId, brandId: audience.brandId, offerId: audience.offerId });
  if (!choice) return { kind: "own" };
  if (audience.status !== "active") return { kind: "off", reason: `audience is ${audience.status}` };
  const chosen = new Set<string>();
  for (const slug of choice.chosenOriginSlugs) {
    const list = await listKindOfOriginSlug(slug);
    if (list) chosen.add(list);
  }
  const own = audienceListKind(audience);
  const entries: Array<AudienceSource | null> = [];
  if (own && chosen.has(own) && ownListOn(audience)) entries.push(null);
  entries.push(...sources.filter((s) => isSourceOn(s) && chosen.has(s.list)));
  if (entries.length === 0) {
    return { kind: "off", reason: `Lead Sourcing chose ${choice.chosenOriginSlugs.join(",") || "nothing"}: no ON list of the audience among them` };
  }
  // Random order (each list its share of serves), stable-partitioned so a source
  // walked out recently comes last.
  const now = Date.now();
  const shuffled = entries.map((e) => ({ e, k: random() })).sort((a, b) => a.k - b.k).map((x) => x.e);
  const fresh = shuffled.filter((e) => !e || !recentlyExhausted(e, now));
  const spent = shuffled.filter((e) => e && recentlyExhausted(e, now));
  return { kind: "sources", sources: [...fresh, ...spent] };
}

/**
 * The answer of GET /orgs/audiences/{id}/sourcing-origin, by what the caller asks:
 *   - a CRM-sourced feature ⟹ crm (unchanged);
 *   - NO slug ⟹ the audience's OWN list, byte-identical to before (lead-service asks
 *     this to learn which source campaign an audience belongs to);
 *   - an ORIGIN slug ⟹ that origin when the audience finds people through it (its own
 *     list, or a source of that list whatever its on/off), else its own list;
 *   - `lead-sourcing` ⟹ one of the lists its choice serves the audience through;
 *   - an OUTREACH slug (the serve label question) ⟹ one of its ON sources at random
 *     (own list when on, each active source kind), preferring those not walked out
 *     recently. null ⟹ no source is ON: an OFF source is never answered.
 * An audience with no source answers its own list in every case.
 */
export async function pickSourcingList(
  audience: AudienceRow,
  featureSlug: string | undefined,
  random: () => number = Math.random
): Promise<AudienceListKind | null> {
  if (isCrmSourcedFeature(featureSlug)) return "crm_contacts";
  const own = audienceListKind(audience);
  if (!featureSlug) return own;
  const sources = (await sourcesOf([audience.id])).get(audience.id) ?? [];
  if (sources.length === 0) return own;
  // Lead Sourcing: one of the lists its CHOICE serves this audience through.
  if (featureSlug === LEAD_SOURCING_SLUG) {
    const pick = await pickLeadSourcing(audience, sources, random);
    if (pick.kind === "own") return own;
    if (pick.kind === "off") return null;
    const first = pick.sources[0];
    return first ? (first.list as AudienceListKind) : own;
  }
  const asked = await listKindOfOriginSlug(featureSlug);
  if (asked) {
    if (asked === own || sources.some((s) => s.list === asked && s.status !== "archived")) return asked;
    return own;
  }
  const on = sources.filter(isSourceOn);
  const fresh = new Set(on.filter((s) => !recentlyExhausted(s)).map((s) => s.list as AudienceListKind));
  const kinds: AudienceListKind[] = [];
  if (own && ownListOn(audience)) kinds.push(own);
  kinds.push(...[...fresh].filter((k) => k !== own));
  if (kinds.length === 0) kinds.push(...new Set(on.map((s) => s.list as AudienceListKind)));
  if (kinds.length === 0) return null;
  return kinds[Math.min(kinds.length - 1, Math.floor(random() * kinds.length))];
}

export async function markSourceServed(sourceId: string): Promise<void> {
  await db
    .update(audienceSources)
    .set({ lastServedAt: new Date(), exhaustedAt: null })
    .where(eq(audienceSources.id, sourceId));
}

/**
 * A serve walked this source out: its reachable ceiling = the distinct people it
 * served for the audience (per-source provenance), stamped with when.
 */
export async function persistSourceExhaustion(sourceId: string, opts: { reachable: boolean }): Promise<void> {
  if (!opts.reachable) {
    await db.update(audienceSources).set({ exhaustedAt: new Date() }).where(eq(audienceSources.id, sourceId));
    return;
  }
  await db.execute(sql`
    update audience_sources s set
      reachable_count = (
        select count(distinct m.person_id)::int from audience_member_sources m
         where m.source_id = s.id and m.audience_id = s.audience_id and m.provenance = 'served'
      ),
      exhausted_at = now(),
      updated_at = now()
     where s.id = ${sourceId}
  `);
}

// ── Creating a source ─────────────────────────────────────────────────────────

export interface NewSource {
  audience: AudienceRow;
  list: "apollo_buying_signal" | "linkedin_engagement";
  signalType: string | null;
  windowDays: number | null;
  name: string;
  apolloAudienceId: string;
  filters: Record<string, unknown> | null;
  apolloCount: number | null;
  status: "active" | "paused";
  userId: string | null;
}

/** Add a source to an audience; an existing one of the same kind is returned untouched. */
export async function addSource(input: NewSource): Promise<{ source: AudienceSource; created: boolean }> {
  const existing = ((await sourcesOf([input.audience.id])).get(input.audience.id) ?? []).find(
    (s) => s.list === input.list && (s.signalType ?? null) === input.signalType
  );
  if (existing) return { source: existing, created: false };
  const now = new Date();
  try {
    const [source] = await db
      .insert(audienceSources)
      .values({
        orgId: input.audience.orgId,
        brandId: input.audience.brandId,
        offerId: input.audience.offerId,
        audienceId: input.audience.id,
        list: input.list,
        signalType: input.signalType,
        windowDays: input.windowDays,
        name: input.name,
        apolloAudienceId: input.apolloAudienceId,
        filters: input.filters,
        apolloCount: input.apolloCount,
        countedAt: input.apolloCount !== null ? now : null,
        status: input.status,
        statusReason: "born",
        statusSetAt: now,
        createdByUserId: input.userId,
      })
      .returning();
    console.log(
      `[human-service] audience_source.created org=${source.orgId} brand=${source.brandId} audience=${source.audienceId} source=${source.id} list=${source.list} signal=${source.signalType ?? "-"} status=${source.status}`
    );
    noteListBuilt(source.id);
    await syncAudienceLiveness([input.audience.id]);
    return { source, created: true };
  } catch (err) {
    if (pgErrorCode(err) !== "23505") throw err;
    const again = ((await sourcesOf([input.audience.id])).get(input.audience.id) ?? []).find(
      (s) => s.list === input.list && (s.signalType ?? null) === input.signalType
    );
    if (!again) throw err;
    return { source: again, created: false };
  }
}

/**
 * The status a new source of `list` is born in: its source campaign's recorded
 * state for the offer (ON active, OFF paused); else the offer's other sources of
 * that list (active when any is), else the offer's audience rows of that list
 * (legacy per-source rows, whole-ICP lists: active when any is); else `fallback`.
 */
export async function sourceBornStatus(
  scope: OfferScope,
  list: AudienceListKind,
  originSlug: string | null,
  fallback: "active" | "paused"
): Promise<"active" | "paused"> {
  if (originSlug) {
    const [state] = await db
      .select({ status: sourceCampaignStates.status })
      .from(sourceCampaignStates)
      .where(
        and(
          eq(sourceCampaignStates.orgId, scope.orgId),
          eq(sourceCampaignStates.brandId, scope.brandId),
          eq(sourceCampaignStates.offerId, scope.offerId),
          eq(sourceCampaignStates.originSlug, originSlug)
        )
      );
    if (state) return state.status === "on" ? "active" : "paused";
  }
  const siblings = (await offerSources(scope, list)).filter((s) => s.status !== "archived");
  if (siblings.length > 0) return siblings.some(isSourceOn) ? "active" : "paused";
  const legacy = (
    await db
      .select()
      .from(audiences)
      .where(
        and(
          eq(audiences.orgId, scope.orgId),
          eq(audiences.brandId, scope.brandId),
          eq(audiences.offerId, scope.offerId),
          notInArray(audiences.status, ["deprecated", "archived"])
        )
      )
  ).filter((r) => audienceListKind(r) === list);
  if (legacy.length > 0) return legacy.some((r) => r.status === "active") ? "active" : "paused";
  return fallback;
}

/** Set the status of the offer's sources of one list. Returns the parents touched. */
export async function setOfferSourcesStatus(
  scope: OfferScope,
  list: AudienceListKind,
  status: "active" | "paused",
  reason: "source_campaign_on" | "source_campaign_off"
): Promise<{ changed: AudienceSource[]; all: AudienceSource[] }> {
  const all = await offerSources(scope, list);
  const from = status === "active" ? "paused" : "active";
  const ids = all.filter((s) => s.status === from).map((s) => s.id);
  if (ids.length === 0) return { changed: [], all };
  const changed = await db
    .update(audienceSources)
    .set({ status, statusReason: reason, statusSetAt: new Date(), updatedAt: new Date() })
    .where(and(inArray(audienceSources.id, ids), eq(audienceSources.status, from)))
    .returning();
  return { changed, all: await offerSources(scope, list) };
}

// ── Liveness: an audience runs while one of its sources is ON ─────────────────

export interface LivenessHold {
  scope: OfferScope;
  originSlug: string;
  campaignId: string | null;
}

/**
 * For each audience CARRYING sources: no source ON (own list off and no active
 * source) while active ⟹ paused by the system (held under `hold`'s origin when
 * given, so that origin's ON resumes it); a source ON while paused by a source
 * campaign OFF (system) ⟹ resumed, its open source holds released. A person's
 * pause is never undone (LEAK-1012). Audiences with no source are left to the
 * existing per-audience rules. Returns what moved.
 */
export async function syncAudienceLiveness(
  audienceIds: string[],
  hold?: LivenessHold
): Promise<{ paused: string[]; resumed: string[] }> {
  const out = { paused: [] as string[], resumed: [] as string[] };
  if (audienceIds.length === 0) return out;
  const rows = await db
    .select()
    .from(audiences)
    .where(and(inArray(audiences.id, [...new Set(audienceIds)]), notInArray(audiences.status, ["deprecated", "archived"])));
  const bySource = await sourcesOf(rows.map((r) => r.id));
  for (const a of rows) {
    const sources = bySource.get(a.id) ?? [];
    if (sources.length === 0) continue;
    const on = ownListOn(a) || sources.some(isSourceOn);
    if (a.status === "active" && !on) {
      await db.transaction(async (tx) => {
        await tx
          .update(audiences)
          .set({ status: "paused", updatedAt: new Date(), ...systemStatus("source_campaign_off") })
          .where(and(eq(audiences.id, a.id), eq(audiences.status, "active")));
        if (hold) {
          await tx
            .insert(sourceCampaignAudienceHolds)
            .values({ ...hold.scope, originSlug: hold.originSlug, audienceId: a.id, campaignId: hold.campaignId })
            .onConflictDoNothing();
        }
      });
      out.paused.push(a.id);
    } else if (on && isSystemResumable(a) && a.statusSetReason === "source_campaign_off") {
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(audiences)
          .set({ status: "active", updatedAt: now, ...systemStatus("source_campaign_on") })
          .where(and(eq(audiences.id, a.id), eq(audiences.status, "paused"), eq(audiences.statusSetBy, "system")));
        await tx
          .update(sourceCampaignAudienceHolds)
          .set({ releasedAt: now })
          .where(and(eq(sourceCampaignAudienceHolds.audienceId, a.id), isNull(sourceCampaignAudienceHolds.releasedAt)));
      });
      out.resumed.push(a.id);
    }
  }
  if (out.paused.length + out.resumed.length > 0) {
    console.log(
      `[human-service] audience_source.liveness paused=${out.paused.join(",") || "-"} resumed=${out.resumed.join(",") || "-"}`
    );
  }
  return out;
}

/** The channel entries the audience's sources add to its `channels[]`. */
export function describeSourceChannels(audienceId: string, sources: AudienceSource[]) {
  return sources
    .filter((s) => s.status !== "archived")
    .map((s) => {
      const size = s.reachableCount ?? s.apolloCount ?? null;
      return {
        channel: "cold_email" as const,
        list: s.list as "apollo_buying_signal" | "linkedin_engagement",
        audienceId,
        sourceId: s.id,
        name: s.name,
        status: s.status as "active" | "paused",
        signal: { type: s.signalType ?? "linkedin_engagement", windowDays: s.windowDays },
        size,
        sizeUnknownReason:
          size !== null ? null : s.list === "linkedin_engagement" ? ("unknown_until_walked" as const) : ("not_counted" as const),
      };
    });
}
