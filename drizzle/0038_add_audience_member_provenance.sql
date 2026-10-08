-- MULTI-SOURCE TAGS (owner 2026-10-08): a person found by several lead sources
-- must carry EVERY source. audience_members gains `provenance`:
--   'served'      = a serve made under that audience handed the person out
--                   (every row before this migration, hence the default).
--   'found_taken' = that audience's FREE search found the person while they were
--                   already taken (served) for the brand; never served again,
--                   tagged from what the free match already knew (no spend).
-- No new index: the brand-scoped reads go audiences.brand_id ->
-- audience_members.audience_id, served by the unique (audience_id, person_id).
ALTER TABLE "audience_members" ADD COLUMN IF NOT EXISTS "provenance" text NOT NULL DEFAULT 'served';
--> statement-breakpoint
-- Backfill from STORED facts only: audience B's free search found a person
-- (a screening or candidate row of B for that apollo person id) who is a member
-- of another audience of the same brand, and B never rejected them
-- (audience_screened_out). Nothing inferred from names. The historical teasers
-- dropped as already-taken were never stored, so they cannot be recovered.
-- Measured on prod 2026-10-08: 34 (audience, person) pairs across 5 brands.
-- Idempotent (ON CONFLICT DO NOTHING on the bridge's unique key). Undo:
-- DELETE FROM audience_members WHERE provenance = 'found_taken' AND joined_at <= <deploy time>.
INSERT INTO "audience_members" ("org_id", "audience_id", "person_id", "source", "confidence", "provenance")
SELECT DISTINCT s.org_id, s.audience_id, p.id, 'apollo', 'provider_confirmed', 'found_taken'
FROM (
  SELECT org_id, audience_id, provider_person_id FROM "audience_teaser_screenings"
  UNION
  SELECT org_id, audience_id, provider_person_id FROM "audience_candidates"
) s
JOIN "audiences" a ON a.id = s.audience_id
JOIN "people" p ON p.org_id = s.org_id AND p.apollo_person_id = s.provider_person_id
WHERE NOT EXISTS (
    SELECT 1 FROM "audience_screened_out" x
    WHERE x.audience_id = s.audience_id AND x.provider_person_id = s.provider_person_id
  )
  AND EXISTS (
    SELECT 1 FROM "audience_members" m2 JOIN "audiences" a2 ON a2.id = m2.audience_id
    WHERE m2.person_id = p.id AND a2.brand_id = a.brand_id AND a2.id <> a.id
  )
ON CONFLICT ("audience_id", "person_id") DO NOTHING;
