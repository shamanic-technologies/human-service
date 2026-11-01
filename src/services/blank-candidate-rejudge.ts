// BLANK-CANDIDATES-1101: the repair of the candidates offered for judgment with no facts about the person.
//
// From 2026-10-11 (mostly 2026-10-27 on, the 2-month re-contact path) candidates were offered with an EMPTY teaser,
// so lead-service's judge saw nobody and declined them. The cause is fixed (person-teaser.ts); this gives the people
// wrongly declined a real judgment: each blank candidate (apollo, `declined` or still `offered`) whose person HAS a
// stored teaser under some audience is re-offered in place, with that teaser. A declined one goes back to `offered`
// with an old `offered_at`, so the next candidates/next of its audience re-offers it (the lapsed-offer retake), and
// the rejection its decline wrote (`audience_screened_out`, reason `declined: …`) is lifted, so its yield window and
// Size stop counting a verdict made on nothing. A blank candidate whose person has no stored teaser anywhere stays
// as it is (counted `noPersonFacts`): it still cannot be judged.
//
// A rejection the pre-pay screen itself wrote (not a `declined: …` reason) was made on a real snapshot: kept, and its
// candidate left untouched (`keptRejection`).
//
// Idempotent (ledger `candidate_rejudges`, unique (reason, candidate)), dry-runnable, reversible (`/revert` puts the
// candidate and the rejection back verbatim). The set is computed, not supplied: "was this candidate offered with no
// facts?" is a fact of our own rows.
import { sql as pg } from "../db/index.js";
import type { TeaserSnapshot } from "../db/schema.js";
import { storedTeasers } from "./person-teaser.js";

interface BlankRow {
  id: string;
  org_id: string;
  audience_id: string;
  provider_person_id: string;
  status: string;
}

export interface RejudgeResult {
  dryRun: boolean;
  reason: string;
  blank: number;
  reoffered: number;
  teaserFilled: number;
  noPersonFacts: number;
  keptRejection: number;
  alreadyRejudged: number;
  byAudience: Array<{ audienceId: string; reoffered: number; teaserFilled: number; noPersonFacts: number }>;
}

const BLANK = pg`(c.teaser IS NULL OR (COALESCE(btrim(c.teaser->>'title'), '') = '' AND COALESCE(btrim(c.teaser->>'headline'), '') = ''))`;
const CHUNK = 1000;

export async function rejudgeBlankCandidates(reason: string, opts: { dryRun: boolean }): Promise<RejudgeResult> {
  if (!reason.trim()) throw new Error("reason is required");
  const rows = await pg<(BlankRow & { done: boolean })[]>`
    SELECT c.id, c.org_id, c.audience_id, c.provider_person_id, c.status,
           EXISTS (SELECT 1 FROM candidate_rejudges r WHERE r.reason = ${reason} AND r.candidate_id = c.id) AS done
      FROM audience_candidates c
     WHERE ${BLANK} AND c.crm_contact IS NULL AND c.status IN ('declined', 'offered')
     ORDER BY c.created_at
  `;
  const result: RejudgeResult = {
    dryRun: opts.dryRun,
    reason,
    blank: rows.length,
    reoffered: 0,
    teaserFilled: 0,
    noPersonFacts: 0,
    keptRejection: 0,
    alreadyRejudged: 0,
    byAudience: [],
  };
  const per = new Map<string, { reoffered: number; teaserFilled: number; noPersonFacts: number }>();
  const tally = (audienceId: string, k: "reoffered" | "teaserFilled" | "noPersonFacts") => {
    const e = per.get(audienceId) ?? { reoffered: 0, teaserFilled: 0, noPersonFacts: 0 };
    e[k] += 1;
    per.set(audienceId, e);
    result[k] += 1;
  };

  const todo = rows.filter((r) => {
    if (r.done) result.alreadyRejudged += 1;
    return !r.done;
  });
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const facts = await storedTeasers(chunk.map((r) => r.provider_person_id));
    for (const row of chunk) {
      const teaser = facts.get(row.provider_person_id);
      if (!teaser) {
        tally(row.audience_id, "noPersonFacts");
        continue;
      }
      const outcome = await rejudgeOne(reason, row, teaser, opts.dryRun);
      if (outcome === "kept_rejection") result.keptRejection += 1;
      else tally(row.audience_id, outcome);
    }
  }
  result.byAudience = [...per.entries()].map(([audienceId, e]) => ({ audienceId, ...e })).sort((a, b) => b.reoffered - a.reoffered);
  console.log(
    `[human-service] blank_candidates.rejudge reason=${reason} dryRun=${opts.dryRun} blank=${result.blank} reoffered=${result.reoffered} teaserFilled=${result.teaserFilled} noPersonFacts=${result.noPersonFacts} keptRejection=${result.keptRejection} already=${result.alreadyRejudged}`
  );
  return result;
}

async function rejudgeOne(
  reason: string,
  row: BlankRow,
  teaser: TeaserSnapshot,
  dryRun: boolean
): Promise<"reoffered" | "teaserFilled" | "kept_rejection"> {
  const [rejection] = await pg<{ id: string; reason: string | null }[]>`
    SELECT id, reason FROM audience_screened_out
     WHERE audience_id = ${row.audience_id}::uuid AND provider_person_id = ${row.provider_person_id}
  `;
  if (rejection && !(rejection.reason ?? "").startsWith("declined:")) return "kept_rejection";
  const outcome = row.status === "declined" ? "reoffered" : "teaserFilled";
  if (dryRun) return outcome;
  await pg.begin(async (transaction) => {
    // postgres.js types a transaction without its call signature; callable at runtime like `pg`.
    const tx = transaction as unknown as typeof pg;
    const [previous] = await tx<Record<string, unknown>[]>`
      SELECT to_jsonb(c) AS row FROM audience_candidates c WHERE c.id = ${row.id}::uuid FOR UPDATE
    `;
    const [lifted] = rejection
      ? await tx<Record<string, unknown>[]>`
          DELETE FROM audience_screened_out s WHERE s.id = ${rejection.id}::uuid RETURNING to_jsonb(s) AS row`
      : [];
    await tx`
      INSERT INTO candidate_rejudges (reason, candidate_id, audience_id, previous, screened_out)
      VALUES (${reason}, ${row.id}::uuid, ${row.audience_id}::uuid, ${JSON.stringify(previous!.row)}::jsonb,
              ${lifted ? JSON.stringify(lifted.row) : null}::jsonb)
    `;
    if (outcome === "reoffered") {
      await tx`
        UPDATE audience_candidates
           SET teaser = ${JSON.stringify(teaser)}::jsonb, status = 'offered', offered_at = now() - interval '1 hour',
               decided_at = NULL, decline_reason = NULL, basis = NULL, reveal_result = NULL
         WHERE id = ${row.id}::uuid`;
    } else {
      await tx`UPDATE audience_candidates SET teaser = ${JSON.stringify(teaser)}::jsonb WHERE id = ${row.id}::uuid`;
    }
  });
  return outcome;
}

export interface RejudgeRevertResult {
  dryRun: boolean;
  reason: string;
  restored: number;
  rejectionsRestored: number;
}

/** Undo a repair: every candidate it touched back as it was, every lifted rejection re-inserted verbatim. */
export async function revertRejudge(reason: string, opts: { dryRun: boolean }): Promise<RejudgeRevertResult> {
  const ledger = await pg<{ id: string; candidate_id: string; previous: Record<string, unknown>; screened_out: Record<string, unknown> | null }[]>`
    SELECT id, candidate_id, previous, screened_out FROM candidate_rejudges WHERE reason = ${reason}
  `;
  const result: RejudgeRevertResult = {
    dryRun: opts.dryRun,
    reason,
    restored: ledger.length,
    rejectionsRestored: ledger.filter((l) => l.screened_out).length,
  };
  if (opts.dryRun) return result;
  for (const l of ledger) {
    await pg.begin(async (transaction) => {
    // postgres.js types a transaction without its call signature; callable at runtime like `pg`.
    const tx = transaction as unknown as typeof pg;
      const p = l.previous;
      await tx`
        UPDATE audience_candidates
           SET teaser = ${p.teaser === null || p.teaser === undefined ? null : JSON.stringify(p.teaser)}::jsonb, status = ${p.status as string},
               offered_at = ${p.offered_at as string}::timestamptz, decided_at = ${(p.decided_at as string | null) ?? null}::timestamptz,
               decline_reason = ${(p.decline_reason as string | null) ?? null}, basis = ${(p.basis as string | null) ?? null},
               reveal_result = ${p.reveal_result === null || p.reveal_result === undefined ? null : JSON.stringify(p.reveal_result)}::jsonb
         WHERE id = ${l.candidate_id}::uuid`;
      const s = l.screened_out;
      if (s) {
        await tx`
          INSERT INTO audience_screened_out (id, org_id, audience_id, provider_person_id, linkedin_url, reason, screened_at)
          VALUES (${s.id as string}::uuid, ${s.org_id as string}::uuid, ${s.audience_id as string}::uuid, ${s.provider_person_id as string},
                  ${(s.linkedin_url as string | null) ?? null}, ${(s.reason as string | null) ?? null}, ${s.screened_at as string}::timestamptz)
          ON CONFLICT DO NOTHING`;
      }
      await tx`DELETE FROM candidate_rejudges WHERE id = ${l.id}::uuid`;
    });
  }
  return result;
}
