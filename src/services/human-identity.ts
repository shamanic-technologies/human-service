// ONE human across the fleet (LEAD-REFONTE-1013, owner 2026-10-13).
//
// Every service that meets a person (a lead we email, a CRM contact, a signup, a
// WhatsApp contact) asks HERE "who is this?" and gets one id per real human,
// whichever client bought them and whichever tool saw them. human-service is the
// ONLY place that decides "same human?"; it never says what the human IS to
// anyone (client, prospect, ...): those categories belong to crm-service and
// lead-service.
//
// Model:
//   human_identities     atomic humans. Never rewritten, never deleted.
//   human_identity_keys  fleet-wide unique keys: email | phone are PROOF;
//                        linkedin_url | apollo_person_id | apify_person_id |
//                        messaging_handle | crm_record only resolve.
//   human_links          merge ('same') / split ('distinct') statements between
//                        two atomic humans, scope 'fleet' or 'org'.
//   human_facts          facts carried on the human (opt_out, do_not_contact).
//   human_identity_events  append-only feed consumers follow by cursor.
//
// The human an org sees is the connected component of the 'same' links visible
// to it (every fleet link + that org's own), minus the pairs a visible
// 'distinct' cuts, named by its OLDEST member. So a merge or a split is a row,
// recorded with who and why, and withdrawing it is the undo.
//
// Scope rule (owner): a merge PROVEN by a shared email or phone is automatic and
// holds for the whole fleet (resolve below makes it). A merge that is only a
// judgment (a person, Jev) holds ONLY for the org that decided it; a fleet 'same'
// is never accepted from a caller.
//
// Concurrency: every write takes ONE transaction-scoped advisory lock, so two
// callers can never mint two humans for one new address. Writes are short
// (a few rows), reads never take it.
import { and, asc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  humanFacts,
  humanIdentities,
  humanIdentityEvents,
  humanIdentityKeys,
  humanLinks,
  people,
  type HumanFact,
  type HumanLink,
} from "../db/schema.js";
import { normalizeEmail, normalizeLinkedinUrl } from "./suppression.js";
import type { MessagingNetwork } from "../lib/messaging-networks.js";
import type { CrmRecordProvider } from "../lib/crm-record-providers.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

export const KEY_KINDS = [
  "email",
  "phone",
  "linkedin_url",
  "apollo_person_id",
  "apify_person_id",
  "messaging_handle",
  "crm_record",
] as const;
export type KeyKind = (typeof KEY_KINDS)[number];
const PROOF_KINDS = new Set<KeyKind>(["email", "phone"]);

// A person seen only through a messaging network (a WhatsApp member known by its
// LID, no phone visible; a LinkedIn member seen through the bridge) is a human
// too (RELATIONSHIP-TAGS-1014): resolvable and creatable on that handle, so a
// judged merge ("Yulia (WA)" = Yuliia Siletska) can be stated here. A handle is
// a RESOLVE key, never proof: it never merges two humans by itself, only an
// org-scoped judgment link does. Stored as `<network>:<id>`, id verbatim (case
// kept: LinkedIn member ids are case-sensitive).
export function messagingHandleKey(network: MessagingNetwork, rawId: string): IdentityKey {
  const id = rawId.trim();
  if (!id) throw new InvalidIdentityKeyError(`${network} handle is blank`);
  return { kind: "messaging_handle", valueNorm: `${network}:${id}` };
}

function parseMessagingHandle(valueNorm: string): { network: string; id: string } {
  const i = valueNorm.indexOf(":");
  return { network: valueNorm.slice(0, i), id: valueNorm.slice(i + 1) };
}

// A person a brand knows ONLY as a record in one of its own tools (a GoHighLevel
// contact, a Stripe customer, a PostHog person, a Clerk user: a name, no email,
// no phone) is a human too (HUMAN-RECORD-KEYS-1017). The key is the vendor's
// record id SCOPED to the client account it lives in, so the same id in two
// clients' accounts is two keys. Like a messaging handle it only RESOLVES: it
// never merges two humans by itself, only an org-scoped judgment link does.
// Stored as `<provider>:<accountId>:<id>`; the account id may not hold ':' so
// the split is unambiguous, the record id is verbatim (case kept, trimmed).
export function crmRecordKey(provider: CrmRecordProvider, rawAccountId: string, rawId: string): IdentityKey {
  const accountId = rawAccountId.trim();
  const id = rawId.trim();
  if (!accountId) throw new InvalidIdentityKeyError(`${provider} record accountId is blank`);
  if (accountId.includes(":")) throw new InvalidIdentityKeyError(`${provider} record accountId may not contain ':'`);
  if (!id) throw new InvalidIdentityKeyError(`${provider} record id is blank`);
  return { kind: "crm_record", valueNorm: `${provider}:${accountId}:${id}` };
}

function parseCrmRecord(valueNorm: string): { provider: string; accountId: string; id: string } {
  const i = valueNorm.indexOf(":");
  const j = valueNorm.indexOf(":", i + 1);
  return { provider: valueNorm.slice(0, i), accountId: valueNorm.slice(i + 1, j), id: valueNorm.slice(j + 1) };
}

export const FACT_KINDS = ["opt_out", "do_not_contact"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface IdentityKey {
  kind: KeyKind;
  valueNorm: string;
}

export class InvalidIdentityKeyError extends Error {}
export class HumanNotFoundError extends Error {
  constructor(readonly humanId: string) {
    super(`human ${humanId} not found`);
  }
}
export class FleetMergeNeedsProofError extends Error {}
export class LinkNotFoundError extends Error {}
export class FactNotFoundError extends Error {}
export class StillOneHumanError extends Error {
  constructor(readonly linkIds: string[]) {
    super(
      `the two humans are still one through other links (${linkIds.join(", ")}): state the split between the atomic humans those links join`
    );
  }
}
export class SeparatedHumansError extends Error {
  constructor(readonly linkIds: string[]) {
    super(`a split statement keeps these humans apart (${linkIds.join(", ")}): withdraw it first`);
  }
}

// --- Keys -------------------------------------------------------------------

// E.164 only: a number without its country code cannot prove anything across
// orgs (0612345678 is a different line in France and in the UK).
export function normalizePhone(raw: string): string {
  let p = raw.trim().replace(/[\s().\-/]/g, "");
  if (p.startsWith("00")) p = `+${p.slice(2)}`;
  if (!/^\+[1-9]\d{6,14}$/.test(p)) {
    throw new InvalidIdentityKeyError(`phone "${raw}" is not an E.164 number (+<country><number>)`);
  }
  return p;
}

export function normalizeKey(kind: KeyKind, raw: string): string {
  let v: string | null;
  switch (kind) {
    case "email":
      v = normalizeEmail(raw);
      if (v && !v.includes("@")) throw new InvalidIdentityKeyError(`email "${raw}" has no @`);
      break;
    case "phone":
      return normalizePhone(raw);
    case "linkedin_url":
      v = normalizeLinkedinUrl(raw);
      break;
    default:
      v = raw.trim() || null;
  }
  if (!v) throw new InvalidIdentityKeyError(`${kind} is blank`);
  return v;
}

function dedupKeys(keys: IdentityKey[]): IdentityKey[] {
  const seen = new Set<string>();
  return keys.filter((k) => {
    const id = `${k.kind}\u0000${k.valueNorm}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// --- Components -------------------------------------------------------------

function uuidArray(ids: string[]): SQL {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )}]::uuid[]`;
}

async function rows<T>(exec: Exec, query: SQL): Promise<T[]> {
  return (await exec.execute(query)) as unknown as T[];
}

// Every atomic human that is one human with `humanId` in the view of `orgId`
// (null = the fleet view: fleet links only).
export async function componentOf(
  exec: Exec,
  humanId: string,
  orgId: string | null
): Promise<string[]> {
  const r = await rows<{ id: string }>(
    exec,
    sql`
    WITH RECURSIVE comp(id) AS (
      SELECT unnest(${uuidArray([humanId])})
      UNION
      SELECT CASE WHEN l.a_human_id = comp.id THEN l.b_human_id ELSE l.a_human_id END
      FROM human_links l
      JOIN comp ON comp.id IN (l.a_human_id, l.b_human_id)
      WHERE l.relation = 'same' AND l.withdrawn_at IS NULL
        AND (l.scope = 'fleet' OR l.org_id = ${orgId}::uuid)
        AND NOT EXISTS (
          SELECT 1 FROM human_links d
          WHERE d.relation = 'distinct' AND d.withdrawn_at IS NULL
            AND (d.scope = 'fleet' OR d.org_id = ${orgId}::uuid)
            AND d.a_human_id = l.a_human_id AND d.b_human_id = l.b_human_id
        )
    )
    SELECT id FROM comp`
  );
  return r.map((x) => x.id);
}

// The id the human goes by: the oldest atomic human of the component.
async function oldestOf(exec: Exec, ids: string[]): Promise<string> {
  const [first] = await exec
    .select({ id: humanIdentities.id })
    .from(humanIdentities)
    .where(inArray(humanIdentities.id, ids))
    .orderBy(asc(humanIdentities.createdAt), asc(humanIdentities.id))
    .limit(1);
  return first.id;
}

export async function canonicalOf(
  exec: Exec,
  humanId: string,
  orgId: string | null
): Promise<{ humanId: string; memberHumanIds: string[] }> {
  const members = await componentOf(exec, humanId, orgId);
  return { humanId: await oldestOf(exec, members), memberHumanIds: members.sort() };
}

// Active fleet 'distinct' statements joining the two sets (a split someone
// stated): an automatic proof merge never crosses one.
async function fleetSeparations(exec: Exec, left: string[], right: string[]): Promise<string[]> {
  const r = await rows<{ id: string }>(
    exec,
    sql`
    SELECT id FROM human_links
    WHERE relation = 'distinct' AND withdrawn_at IS NULL AND scope = 'fleet'
      AND ((a_human_id = ANY(${uuidArray(left)}) AND b_human_id = ANY(${uuidArray(right)}))
        OR (a_human_id = ANY(${uuidArray(right)}) AND b_human_id = ANY(${uuidArray(left)})))`
  );
  return r.map((x) => x.id);
}

// --- Events -----------------------------------------------------------------

export type HumanEventType =
  | "human.created"
  | "human.keys_attached"
  | "human.linked"
  | "human.separated"
  | "human.link_withdrawn"
  | "human.fact_stated"
  | "human.fact_withdrawn";

export async function emit(
  exec: Exec,
  type: HumanEventType,
  orgId: string | null,
  humanIds: string[],
  data: Record<string, unknown>
): Promise<void> {
  await exec.insert(humanIdentityEvents).values({ type, orgId, humanIds, data });
}

export async function lockIdentityWrites(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('human-identity-writes'))`);
}

// --- Resolve ----------------------------------------------------------------

export interface ResolveArgs {
  // The org asking: decides which org-scoped links apply to the answer. null =
  // the fleet view.
  orgId: string | null;
  keys: IdentityKey[];
  // The service stating that these keys are one contact.
  source: string;
  // false = read only: no human created, no key attached, no merge.
  create: boolean;
}

export interface ResolveResult {
  // The human in the asking org's view, null when nobody holds a key and
  // create=false.
  humanId: string | null;
  // The atomic human the keys landed on (what a per-org record should point to).
  atomicHumanId: string | null;
  created: boolean;
  // Fleet merges this call made (a proof key held by another human).
  mergedHumanIds: string[];
  // Proof merges NOT made because a split keeps the humans apart.
  separatedHumanIds: string[];
}

async function holdersOf(exec: Exec, keys: IdentityKey[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  const found = await exec
    .select({ kind: humanIdentityKeys.kind, valueNorm: humanIdentityKeys.valueNorm, humanId: humanIdentityKeys.humanId })
    .from(humanIdentityKeys)
    .where(
      or(...keys.map((k) => and(eq(humanIdentityKeys.kind, k.kind), eq(humanIdentityKeys.valueNorm, k.valueNorm))))
    );
  for (const f of found) out.set(`${f.kind}\u0000${f.valueNorm}`, f.humanId);
  return out;
}

const keyId = (k: IdentityKey) => `${k.kind}\u0000${k.valueNorm}`;

async function createHuman(exec: Exec, createdBy: string): Promise<string> {
  const [h] = await exec.insert(humanIdentities).values({ createdBy }).returning({ id: humanIdentities.id });
  return h.id;
}

async function attachKeys(exec: Exec, humanId: string, keys: IdentityKey[], source: string): Promise<IdentityKey[]> {
  if (keys.length === 0) return [];
  const inserted = await exec
    .insert(humanIdentityKeys)
    .values(keys.map((k) => ({ humanId, kind: k.kind, valueNorm: k.valueNorm, source })))
    .onConflictDoNothing({ target: [humanIdentityKeys.kind, humanIdentityKeys.valueNorm] })
    .returning({ kind: humanIdentityKeys.kind, valueNorm: humanIdentityKeys.valueNorm });
  return inserted.map((k) => ({ kind: k.kind as KeyKind, valueNorm: k.valueNorm }));
}

function ordered(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

// The keys given together are ONE contact (the source says so). Proof keys
// (email, phone) held by different humans therefore merge them, fleet-wide,
// unless a split keeps them apart. Other keys only resolve: a LinkedIn URL or a
// provider id held by another human never merges anything.
// MUST run inside a transaction holding lockIdentityWrites when create=true.
export async function resolveIdentityTx(tx: Tx, args: ResolveArgs): Promise<ResolveResult> {
  const keys = dedupKeys(args.keys);
  const holders = await holdersOf(tx, keys);
  const proofHolders: Array<{ key: IdentityKey; humanId: string }> = [];
  const weakHolders: Array<{ key: IdentityKey; humanId: string }> = [];
  for (const k of keys) {
    const h = holders.get(keyId(k));
    if (!h) continue;
    (PROOF_KINDS.has(k.kind) ? proofHolders : weakHolders).push({ key: k, humanId: h });
  }
  const anchorHolder = proofHolders[0] ?? weakHolders[0] ?? null;

  if (!args.create) {
    if (!anchorHolder) {
      return { humanId: null, atomicHumanId: null, created: false, mergedHumanIds: [], separatedHumanIds: [] };
    }
    const view = await canonicalOf(tx, anchorHolder.humanId, args.orgId);
    return {
      humanId: view.humanId,
      atomicHumanId: anchorHolder.humanId,
      created: false,
      mergedHumanIds: [],
      separatedHumanIds: [],
    };
  }

  let anchor: string;
  let created = false;
  if (anchorHolder) {
    anchor = anchorHolder.humanId;
  } else {
    anchor = await createHuman(tx, args.source);
    created = true;
  }

  const mergedHumanIds: string[] = [];
  const separatedHumanIds: string[] = [];
  const anchorKey = anchorHolder?.key ?? null;
  for (const ph of proofHolders) {
    if (ph.humanId === anchor) continue;
    const anchorComp = await componentOf(tx, anchor, null);
    if (anchorComp.includes(ph.humanId)) continue;
    const otherComp = await componentOf(tx, ph.humanId, null);
    const cuts = await fleetSeparations(tx, anchorComp, otherComp);
    if (cuts.length > 0) {
      separatedHumanIds.push(ph.humanId);
      console.warn(
        `[human-service] human_identity.proof_merge_blocked anchor=${anchor} other=${ph.humanId} splits=${cuts.join(",")}`
      );
      continue;
    }
    const [a, b] = ordered(anchor, ph.humanId);
    const [link] = await tx
      .insert(humanLinks)
      .values({
        relation: "same",
        scope: "fleet",
        orgId: null,
        aHumanId: a,
        bHumanId: b,
        basis: ph.key.kind === "phone" ? "shared_phone" : "shared_email",
        proofKind: ph.key.kind,
        proofValueNorm: ph.key.valueNorm,
        judgedBy: "proof",
        statedBy: args.source,
        evidence: `${args.source} stated ${anchorKey ? `${anchorKey.kind} ${anchorKey.valueNorm}` : "a new contact"} and ${ph.key.kind} ${ph.key.valueNorm} on one contact`,
      })
      .returning();
    const view = await canonicalOf(tx, anchor, null);
    await emit(tx, "human.linked", null, [a, b], {
      linkId: link.id,
      relation: "same",
      scope: "fleet",
      basis: link.basis,
      humanId: view.humanId,
      memberHumanIds: view.memberHumanIds,
    });
    mergedHumanIds.push(ph.humanId);
  }

  // Keys nobody holds join the anchor. A weak key held elsewhere stays there.
  const unheld = keys.filter((k) => !holders.has(keyId(k)));
  const attached = await attachKeys(tx, anchor, unheld, args.source);
  if (created) {
    await emit(tx, "human.created", null, [anchor], { humanId: anchor, source: args.source, keys: attached });
  } else if (attached.length > 0) {
    await emit(tx, "human.keys_attached", null, [anchor], { humanId: anchor, source: args.source, keys: attached });
  }

  const view = await canonicalOf(tx, anchor, args.orgId);
  return { humanId: view.humanId, atomicHumanId: anchor, created, mergedHumanIds, separatedHumanIds };
}

export async function resolveIdentity(args: ResolveArgs): Promise<ResolveResult> {
  if (!args.create) return db.transaction((tx) => resolveIdentityTx(tx, args));
  return db.transaction(async (tx) => {
    await lockIdentityWrites(tx);
    return resolveIdentityTx(tx, args);
  });
}

// --- Links (merge / split statements) ---------------------------------------

export interface StateLinkArgs {
  // null = fleet. A fleet 'same' is refused: only proof merges are fleet-wide,
  // and resolve makes those.
  orgId: string | null;
  relation: "same" | "distinct";
  humanIds: [string, string];
  judgedBy: string;
  statedBy: string;
  evidence: string;
}

async function assertHumansExist(exec: Exec, ids: string[]): Promise<void> {
  const found = await exec
    .select({ id: humanIdentities.id })
    .from(humanIdentities)
    .where(inArray(humanIdentities.id, ids));
  const have = new Set(found.map((f) => f.id));
  for (const id of ids) if (!have.has(id)) throw new HumanNotFoundError(id);
}

// Org view cuts: active 'distinct' statements visible to the org between the sets.
async function visibleSeparations(
  exec: Exec,
  orgId: string | null,
  left: string[],
  right: string[]
): Promise<string[]> {
  const r = await rows<{ id: string }>(
    exec,
    sql`
    SELECT id FROM human_links
    WHERE relation = 'distinct' AND withdrawn_at IS NULL
      AND (scope = 'fleet' OR org_id = ${orgId}::uuid)
      AND ((a_human_id = ANY(${uuidArray(left)}) AND b_human_id = ANY(${uuidArray(right)}))
        OR (a_human_id = ANY(${uuidArray(right)}) AND b_human_id = ANY(${uuidArray(left)})))`
  );
  return r.map((x) => x.id);
}

export async function stateLink(
  args: StateLinkArgs
): Promise<{ changed: boolean; link: HumanLink | null; humanIds: string[] }> {
  if (args.relation === "same" && args.orgId === null) {
    throw new FleetMergeNeedsProofError(
      "a fleet-wide merge needs a shared email or phone: resolve both keys together; a judgment merge is stated for one org (orgId)"
    );
  }
  const [x, y] = args.humanIds;
  if (x === y) throw new InvalidIdentityKeyError("humanIds must name two different humans");
  return db.transaction(async (tx) => {
    await lockIdentityWrites(tx);
    await assertHumansExist(tx, [x, y]);
    const scope = args.orgId === null ? "fleet" : "org";
    const [a, b] = ordered(x, y);
    const compX = await componentOf(tx, x, args.orgId);

    if (args.relation === "same") {
      if (compX.includes(y)) {
        const view = await canonicalOf(tx, x, args.orgId);
        return { changed: false, link: null, humanIds: [view.humanId] };
      }
      const compY = await componentOf(tx, y, args.orgId);
      const cuts = await visibleSeparations(tx, args.orgId, compX, compY);
      if (cuts.length > 0) throw new SeparatedHumansError(cuts);
    }

    const [link] = await tx
      .insert(humanLinks)
      .values({
        relation: args.relation,
        scope,
        orgId: args.orgId,
        aHumanId: a,
        bHumanId: b,
        basis: "judgment",
        judgedBy: args.judgedBy,
        statedBy: args.statedBy,
        evidence: args.evidence,
      })
      .returning();

    if (args.relation === "distinct") {
      const after = await componentOf(tx, x, args.orgId);
      if (after.includes(y)) {
        const path = await rows<{ id: string }>(
          tx,
          sql`SELECT id FROM human_links WHERE relation = 'same' AND withdrawn_at IS NULL
              AND (scope = 'fleet' OR org_id = ${args.orgId}::uuid)
              AND a_human_id = ANY(${uuidArray(after)}) AND b_human_id = ANY(${uuidArray(after)})`
        );
        throw new StillOneHumanError(path.map((p) => p.id));
      }
      const left = await canonicalOf(tx, x, args.orgId);
      const right = await canonicalOf(tx, y, args.orgId);
      await emit(tx, "human.separated", args.orgId, [a, b], {
        linkId: link.id,
        scope,
        humanIds: [left.humanId, right.humanId],
      });
      return { changed: true, link, humanIds: [left.humanId, right.humanId] };
    }

    const view = await canonicalOf(tx, x, args.orgId);
    await emit(tx, "human.linked", args.orgId, [a, b], {
      linkId: link.id,
      relation: "same",
      scope,
      basis: "judgment",
      humanId: view.humanId,
      memberHumanIds: view.memberHumanIds,
    });
    return { changed: true, link, humanIds: [view.humanId] };
  });
}

// Withdraw a merge or split statement (the undo). An org statement is withdrawn
// only by its org; a fleet statement only without an org.
export async function withdrawLink(args: {
  linkId: string;
  orgId: string | null;
  withdrawnBy: string;
  reason: string;
}): Promise<{ changed: boolean; link: HumanLink }> {
  return db.transaction(async (tx) => {
    await lockIdentityWrites(tx);
    const [link] = await tx.select().from(humanLinks).where(eq(humanLinks.id, args.linkId)).limit(1);
    if (!link || (link.orgId ?? null) !== args.orgId) throw new LinkNotFoundError(args.linkId);
    if (link.withdrawnAt) return { changed: false, link };
    const [updated] = await tx
      .update(humanLinks)
      .set({ withdrawnAt: new Date(), withdrawnBy: args.withdrawnBy, withdrawReason: args.reason })
      .where(eq(humanLinks.id, link.id))
      .returning();
    await emit(tx, "human.link_withdrawn", link.orgId, [link.aHumanId, link.bHumanId], {
      linkId: link.id,
      relation: link.relation,
      scope: link.scope,
    });
    return { changed: true, link: updated };
  });
}

// --- Facts ------------------------------------------------------------------

export async function stateFact(args: {
  humanId: string;
  kind: FactKind;
  statedByOrgId: string | null;
  source: string;
  evidence: string;
  statedAt: Date | null;
}): Promise<HumanFact> {
  return db.transaction(async (tx) => {
    await assertHumansExist(tx, [args.humanId]);
    const [fact] = await tx
      .insert(humanFacts)
      .values({
        humanId: args.humanId,
        kind: args.kind,
        statedByOrgId: args.statedByOrgId,
        source: args.source,
        evidence: args.evidence,
        ...(args.statedAt ? { statedAt: args.statedAt } : {}),
      })
      .returning();
    await emit(tx, "human.fact_stated", null, [args.humanId], {
      factId: fact.id,
      humanId: args.humanId,
      kind: fact.kind,
      statedByOrgId: fact.statedByOrgId,
    });
    return fact;
  });
}

export async function withdrawFact(args: {
  factId: string;
  withdrawnBy: string;
  reason: string;
}): Promise<{ changed: boolean; fact: HumanFact }> {
  return db.transaction(async (tx) => {
    const [fact] = await tx.select().from(humanFacts).where(eq(humanFacts.id, args.factId)).limit(1);
    if (!fact) throw new FactNotFoundError(args.factId);
    if (fact.withdrawnAt) return { changed: false, fact };
    const [updated] = await tx
      .update(humanFacts)
      .set({ withdrawnAt: new Date(), withdrawnBy: args.withdrawnBy, withdrawReason: args.reason })
      .where(eq(humanFacts.id, fact.id))
      .returning();
    await emit(tx, "human.fact_withdrawn", null, [fact.humanId], {
      factId: fact.id,
      humanId: fact.humanId,
      kind: fact.kind,
    });
    return { changed: true, fact: updated };
  });
}

// --- Read -------------------------------------------------------------------

export interface HumanView {
  humanId: string;
  memberHumanIds: string[];
  emails: string[];
  phones: string[];
  linkedinUrls: string[];
  providerPersonIds: Array<{ provider: "apollo" | "apify"; id: string }>;
  messagingHandles: Array<{ network: string; id: string }>;
  crmRecords: Array<{ provider: string; accountId: string; id: string }>;
  facts: Array<{
    factId: string;
    humanId: string;
    kind: string;
    statedByOrgId: string | null;
    source: string;
    evidence: string;
    statedAt: string;
  }>;
  people: Array<{ orgId: string; personId: string }>;
  links: Array<{
    linkId: string;
    relation: string;
    scope: string;
    orgId: string | null;
    humanIds: [string, string];
    basis: string;
    judgedBy: string;
    statedBy: string;
    evidence: string;
    createdAt: string;
  }>;
}

export async function getHumanView(humanId: string, orgId: string | null): Promise<HumanView | null> {
  const [exists] = await db
    .select({ id: humanIdentities.id })
    .from(humanIdentities)
    .where(eq(humanIdentities.id, humanId))
    .limit(1);
  if (!exists) return null;
  const { humanId: canonical, memberHumanIds } = await canonicalOf(db, humanId, orgId);
  const [keys, facts, persons, links] = await Promise.all([
    db
      .select()
      .from(humanIdentityKeys)
      .where(inArray(humanIdentityKeys.humanId, memberHumanIds))
      .orderBy(asc(humanIdentityKeys.createdAt), asc(humanIdentityKeys.valueNorm)),
    db
      .select()
      .from(humanFacts)
      .where(and(inArray(humanFacts.humanId, memberHumanIds), isNull(humanFacts.withdrawnAt)))
      .orderBy(asc(humanFacts.statedAt)),
    orgId
      ? db
          .select({ orgId: people.orgId, personId: people.id })
          .from(people)
          .where(and(eq(people.orgId, orgId), inArray(people.humanId, memberHumanIds)))
      : Promise.resolve([] as Array<{ orgId: string; personId: string }>),
    rows<{
      id: string;
      relation: string;
      scope: string;
      org_id: string | null;
      a_human_id: string;
      b_human_id: string;
      basis: string;
      judged_by: string;
      stated_by: string;
      evidence: string;
      created_at: string | Date;
    }>(
      db,
      sql`SELECT * FROM human_links WHERE withdrawn_at IS NULL
          AND (scope = 'fleet' OR org_id = ${orgId}::uuid)
          AND (a_human_id = ANY(${uuidArray(memberHumanIds)}) OR b_human_id = ANY(${uuidArray(memberHumanIds)}))
          ORDER BY created_at, id`
    ),
  ]);
  const of = (kind: KeyKind) => keys.filter((k) => k.kind === kind).map((k) => k.valueNorm);
  return {
    humanId: canonical,
    memberHumanIds,
    emails: of("email"),
    phones: of("phone"),
    linkedinUrls: of("linkedin_url"),
    providerPersonIds: [
      ...of("apollo_person_id").map((id) => ({ provider: "apollo" as const, id })),
      ...of("apify_person_id").map((id) => ({ provider: "apify" as const, id })),
    ],
    messagingHandles: of("messaging_handle").map(parseMessagingHandle),
    crmRecords: of("crm_record").map(parseCrmRecord),
    facts: facts.map((f) => ({
      factId: f.id,
      humanId: f.humanId,
      kind: f.kind,
      statedByOrgId: f.statedByOrgId,
      source: f.source,
      evidence: f.evidence,
      statedAt: f.statedAt.toISOString(),
    })),
    people: persons,
    links: links.map((l) => ({
      linkId: l.id,
      relation: l.relation,
      scope: l.scope,
      orgId: l.org_id,
      humanIds: [l.a_human_id, l.b_human_id],
      basis: l.basis,
      judgedBy: l.judged_by,
      statedBy: l.stated_by,
      evidence: l.evidence,
      createdAt: new Date(l.created_at).toISOString(),
    })),
  };
}

// The human an org's person is, in that org's view. null = not linked yet.
export async function humanIdOfPerson(
  exec: Exec,
  orgId: string,
  personHumanId: string | null
): Promise<string | null> {
  if (!personHumanId) return null;
  return (await canonicalOf(exec, personHumanId, orgId)).humanId;
}

// --- Feed -------------------------------------------------------------------

export async function listEvents(args: {
  after: number;
  limit: number;
  orgId: string | null;
}): Promise<{
  events: Array<{
    id: string;
    type: string;
    orgId: string | null;
    humanIds: string[];
    data: unknown;
    createdAt: string;
  }>;
  nextCursor: string;
  hasMore: boolean;
}> {
  const scope = args.orgId
    ? or(isNull(humanIdentityEvents.orgId), eq(humanIdentityEvents.orgId, args.orgId))
    : undefined;
  const found = await db
    .select()
    .from(humanIdentityEvents)
    .where(and(gt(humanIdentityEvents.id, args.after), scope))
    .orderBy(asc(humanIdentityEvents.id))
    .limit(args.limit + 1);
  const page = found.slice(0, args.limit);
  return {
    events: page.map((e) => ({
      id: String(e.id),
      type: e.type,
      orgId: e.orgId,
      humanIds: e.humanIds,
      data: e.data,
      createdAt: e.createdAt.toISOString(),
    })),
    nextCursor: String(page.length ? page[page.length - 1].id : args.after),
    hasMore: found.length > args.limit,
  };
}
