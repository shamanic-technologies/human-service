// BLANK-CANDIDATES-1101: a candidate is never offered for judgment without facts about the PERSON.
//
// lead-service judges a candidate (does this person belong to the audience's target?) on the teaser snapshot the
// candidate carries, before paying to reveal them. A candidate with no snapshot (or one naming no role) is judged on
// nothing and declined: 4,275 such rows from 2026-10-11 to 2026-11-01, almost all of them from the 2-month re-contact
// path (recontact-rereach.ts), which rebuilt a candidate from the person's stored teaser when people served in
// July-September never had one stored (snapshots are stored since 2026-09-17).
//
// THE PERSON'S FACTS DO NOT DEPEND ON THE AUDIENCE: a teaser snapshot is what the provider's free search said about
// that apollo person (title, headline, employer...). So a person with no snapshot under THIS audience is looked up
// under every audience that ever held one (a screening, a candidate, a buffered teaser), latest first, then in what
// apollo-service's stored paid reveal said about them (free read, no Apollo call). Still none ⟹ the person is NOT
// offered (logged), never offered blank.
import { sql as pg } from "../db/index.js";
import type { TeaserSnapshot } from "../db/schema.js";
import { readApolloPersonFacts } from "../lib/apollo-person-facts.js";

const filled = (v: string | null | undefined): boolean => typeof v === "string" && v.trim().length > 0;

/** A snapshot a judge can read about the PERSON: it names their role (title or headline). */
export function isJudgeableTeaser(t: TeaserSnapshot | null | undefined): t is TeaserSnapshot {
  return !!t && (filled(t.title) || filled(t.headline));
}

/** The latest judgeable stored snapshot of each apollo person, from any audience. Free, one read. */
export async function storedTeasers(providerPersonIds: string[]): Promise<Map<string, TeaserSnapshot>> {
  const ids = [...new Set(providerPersonIds.filter((x) => !!x))];
  const out = new Map<string, TeaserSnapshot>();
  if (ids.length === 0) return out;
  const rows = await pg<{ pid: string; teaser: TeaserSnapshot }[]>`
    SELECT DISTINCT ON (pid) pid, teaser FROM (
      SELECT provider_person_id AS pid, teaser, created_at FROM audience_teaser_screenings
       WHERE provider_person_id = ANY(${ids}) AND teaser IS NOT NULL
      UNION ALL
      SELECT provider_person_id, teaser, created_at FROM audience_candidates
       WHERE provider_person_id = ANY(${ids}) AND teaser IS NOT NULL
      UNION ALL
      SELECT provider_person_id, teaser, created_at FROM audience_teaser_buffer
       WHERE provider_person_id = ANY(${ids}) AND teaser IS NOT NULL
    ) s
    WHERE COALESCE(btrim(s.teaser->>'title'), '') <> '' OR COALESCE(btrim(s.teaser->>'headline'), '') <> ''
    ORDER BY pid, created_at DESC
  `;
  for (const r of rows) out.set(r.pid, r.teaser);
  // Nothing stored here (people served before snapshots were stored): what apollo-service's stored paid reveal said
  // about them, free (an id it never revealed answers "not known").
  const missing = ids.filter((id) => !out.has(id));
  if (missing.length > 0) {
    for (const [pid, t] of await readApolloPersonFacts(missing)) if (isJudgeableTeaser(t)) out.set(pid, t);
  }
  return out;
}

/**
 * Every item carrying a judgeable teaser: its own, else the person's stored one. Items with none anywhere are
 * returned apart (`blank`), never offered.
 */
export async function withPersonTeasers<T extends { providerPersonId: string; teaser: TeaserSnapshot | null }>(
  items: T[]
): Promise<{ judgeable: T[]; blank: T[] }> {
  const missing = items.filter((i) => !isJudgeableTeaser(i.teaser)).map((i) => i.providerPersonId);
  const stored = missing.length > 0 ? await storedTeasers(missing) : new Map<string, TeaserSnapshot>();
  const judgeable: T[] = [];
  const blank: T[] = [];
  for (const item of items) {
    if (isJudgeableTeaser(item.teaser)) judgeable.push(item);
    else {
      const t = stored.get(item.providerPersonId);
      if (t) judgeable.push({ ...item, teaser: t });
      else blank.push(item);
    }
  }
  return { judgeable, blank };
}
