// One Apollo person = one human, on the provider's own reveal record
// (LEDGER-RESIDUAL-1025-HUMANS).
//
// A human known ONLY by an Apollo person id (an old lead that never held an
// email) and a human known by the email Apollo's paid reveal returned for that
// same person id are one human. A provider id is a RESOLVE key here, so resolve
// never merges on it (a caller can mis-attach an id). This is different: the
// statement "person id P has email E" comes from the provider that OWNS the id,
// recorded by apollo-service when its paid reveal (/enrich, /match) of P
// returned E. That is the same evidence a serve already uses to put P and E on
// one `people` row; here it is read from the record of every reveal, including
// the ones made before human-service kept its own serve record (2026-06-15).
//
// Accepted only when the record is unambiguous, everything else is refused and
// counted with its reason, never guessed:
//   - P's reveals returned exactly ONE address E, and no other Apollo person id
//     was ever revealed with E (a shared mailbox names nobody);
//   - the human holding P holds no other email / phone (it would be a second
//     claim about who P is);
//   - the human holding E is not another Apollo person (holds no other id);
//   - no fleet split keeps the two apart.
// Nothing is inferred from a name, a company or any similarity.
//
// The merge is the normal fleet 'same' link + `human.linked` event, basis
// `provider_record`, so every consumer following the feed (lead-service) folds
// the two humans like any proof merge. Withdrawing the link is the undo.
// Idempotent: a merged pair is one component, so a replay counts `already_one`.
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { humanLinks } from "../db/schema.js";
import { canonicalOf, componentOf, emit, lockIdentityWrites, type Exec } from "./human-identity.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const PROVIDER_RECORD_SOURCE = "apollo-service:reveal-record";
const BATCH = 1000;

// What apollo-service's stored reveals answer for a batch of person ids. Emails
// lowercased + trimmed.
export interface RevealRecord {
  emailsByPersonId: Map<string, string[]>;
  personIdsByEmail: Map<string, string[]>;
}
export type RevealRecordReader = (apolloPersonIds: string[]) => Promise<RevealRecord>;

export const REFUSAL_REASONS = [
  "id_revealed_several_addresses",
  "address_revealed_for_several_people",
  "id_holder_has_another_address",
  "address_holder_is_another_apollo_person",
  "split_stated",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface ProviderRecordMergeResult {
  dryRun: boolean;
  // Humans holding an Apollo person id and no email / phone, looked at.
  examined: number;
  // No stored reveal of that id returned an address.
  noRevealedAddress: number;
  // The revealed address is held by no human: nothing to merge.
  addressUnknownHere: number;
  // Already one human (a replay lands here).
  alreadyOne: number;
  // Merged (dry run: would merge).
  merged: number;
  refused: Record<RefusalReason, number>;
  // First merges / refusals, for reading the decision by eye.
  sample: Array<{ apolloPersonId: string; email: string | null; outcome: string; humanIds: string[] }>;
}

async function rows<T>(exec: Exec, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await exec.execute(query)) as unknown as T[];
}

// Every human holding an Apollo person id and no proof key of its own, by key.
async function candidates(limit: number | null): Promise<Array<{ humanId: string; apolloPersonId: string }>> {
  const r = await rows<{ human_id: string; value_norm: string }>(
    db,
    sql`SELECT k.human_id, k.value_norm FROM human_identity_keys k
        WHERE k.kind = 'apollo_person_id'
          AND NOT EXISTS (SELECT 1 FROM human_identity_keys p
                          WHERE p.human_id = k.human_id AND p.kind IN ('email', 'phone'))
        ORDER BY k.created_at, k.id
        ${limit ? sql`LIMIT ${limit}` : sql``}`
  );
  return r.map((x) => ({ humanId: x.human_id, apolloPersonId: x.value_norm }));
}

type Decision =
  | { outcome: "merge"; email: string; a: string; b: string }
  | { outcome: "already_one" | "address_unknown_here" | "no_revealed_address" | RefusalReason; email: string | null; a: string; b: string | null };

async function keysOf(exec: Exec, humanIds: string[], kinds: string[]): Promise<Array<{ kind: string; value: string }>> {
  return rows<{ kind: string; value: string }>(
    exec,
    sql`SELECT kind, value_norm AS value FROM human_identity_keys
        WHERE human_id = ANY(ARRAY[${sql.join(humanIds.map((id) => sql`${id}`), sql`, `)}]::uuid[])
          AND kind = ANY(ARRAY[${sql.join(kinds.map((k) => sql`${k}`), sql`, `)}]::text[])`
  );
}

// Decided inside the write transaction (under the identity lock) so the state
// read is the state merged.
async function decide(
  exec: Exec,
  holder: string,
  apolloPersonId: string,
  record: RevealRecord
): Promise<Decision> {
  const emails = record.emailsByPersonId.get(apolloPersonId) ?? [];
  if (emails.length === 0) return { outcome: "no_revealed_address", email: null, a: holder, b: null };
  if (emails.length > 1) return { outcome: "id_revealed_several_addresses", email: null, a: holder, b: null };
  const email = emails[0];
  const ids = record.personIdsByEmail.get(email) ?? [];
  if (ids.length !== 1 || ids[0] !== apolloPersonId) {
    return { outcome: "address_revealed_for_several_people", email, a: holder, b: null };
  }
  const [held] = await rows<{ human_id: string }>(
    exec,
    sql`SELECT human_id FROM human_identity_keys WHERE kind = 'email' AND value_norm = ${email}`
  );
  if (!held) return { outcome: "address_unknown_here", email, a: holder, b: null };
  const b = held.human_id;
  const compA = await componentOf(exec, holder, null);
  if (compA.includes(b)) return { outcome: "already_one", email, a: holder, b };
  const proofA = await keysOf(exec, compA, ["email", "phone"]);
  if (proofA.some((k) => !(k.kind === "email" && k.value === email))) {
    return { outcome: "id_holder_has_another_address", email, a: holder, b };
  }
  const compB = await componentOf(exec, b, null);
  const idsB = await keysOf(exec, compB, ["apollo_person_id"]);
  if (idsB.some((k) => k.value !== apolloPersonId)) {
    return { outcome: "address_holder_is_another_apollo_person", email, a: holder, b };
  }
  const [cut] = await rows<{ id: string }>(
    exec,
    sql`SELECT id FROM human_links
        WHERE relation = 'distinct' AND withdrawn_at IS NULL AND scope = 'fleet'
          AND ((a_human_id = ANY(${uuids(compA)}) AND b_human_id = ANY(${uuids(compB)}))
            OR (a_human_id = ANY(${uuids(compB)}) AND b_human_id = ANY(${uuids(compA)})))
        LIMIT 1`
  );
  if (cut) return { outcome: "split_stated", email, a: holder, b };
  return { outcome: "merge", email, a: holder, b };
}

function uuids(ids: string[]) {
  return sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;
}

async function link(tx: Tx, d: { email: string; a: string; b: string }, apolloPersonId: string): Promise<void> {
  const [x, y] = d.a < d.b ? [d.a, d.b] : [d.b, d.a];
  const [row] = await tx
    .insert(humanLinks)
    .values({
      relation: "same",
      scope: "fleet",
      orgId: null,
      aHumanId: x,
      bHumanId: y,
      basis: "provider_record",
      proofKind: "apollo_person_id",
      proofValueNorm: apolloPersonId,
      judgedBy: "provider_record",
      statedBy: PROVIDER_RECORD_SOURCE,
      evidence: `apollo-service's paid reveal of apollo person id ${apolloPersonId} returned ${d.email}, its only address, revealed for no other person id`,
    })
    .returning();
  const view = await canonicalOf(tx, d.a, null);
  await emit(tx, "human.linked", null, [x, y], {
    linkId: row.id,
    relation: "same",
    scope: "fleet",
    basis: row.basis,
    humanId: view.humanId,
    memberHumanIds: view.memberHumanIds,
  });
}

export async function mergeOnProviderRecords(args: {
  dryRun: boolean;
  readRecords: RevealRecordReader;
  limit?: number | null;
}): Promise<ProviderRecordMergeResult> {
  const result: ProviderRecordMergeResult = {
    dryRun: args.dryRun,
    examined: 0,
    noRevealedAddress: 0,
    addressUnknownHere: 0,
    alreadyOne: 0,
    merged: 0,
    refused: Object.fromEntries(REFUSAL_REASONS.map((r) => [r, 0])) as Record<RefusalReason, number>,
    sample: [],
  };
  const all = await candidates(args.limit ?? null);
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    const record = await args.readRecords([...new Set(batch.map((c) => c.apolloPersonId))]);
    for (const c of batch) {
      result.examined++;
      const decision = await db.transaction(async (tx) => {
        if (!args.dryRun) await lockIdentityWrites(tx);
        const d = await decide(tx, c.humanId, c.apolloPersonId, record);
        if (d.outcome === "merge" && !args.dryRun) await link(tx, d, c.apolloPersonId);
        return d;
      });
      switch (decision.outcome) {
        case "merge":
          result.merged++;
          break;
        case "already_one":
          result.alreadyOne++;
          break;
        case "address_unknown_here":
          result.addressUnknownHere++;
          break;
        case "no_revealed_address":
          result.noRevealedAddress++;
          break;
        default:
          result.refused[decision.outcome]++;
      }
      if (decision.outcome !== "no_revealed_address" && decision.outcome !== "address_unknown_here" && result.sample.length < 20) {
        result.sample.push({
          apolloPersonId: c.apolloPersonId,
          email: decision.email,
          outcome: decision.outcome,
          humanIds: decision.b ? [decision.a, decision.b] : [decision.a],
        });
      }
    }
  }
  console.log(`[human-service] human_identity.provider_record_merge ${JSON.stringify({ ...result, sample: undefined })}`);
  return result;
}
