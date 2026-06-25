-- A deprecated provider-variant audience (e.g. "<base> [Apify]", set by the
-- apify->apollo migration) carries a durable link to its ACTIVE canonical
-- replacement. Membership / stats reads resolve a deprecated match to this
-- canonical audience so every lead from the same logical audience renders with
-- the same clean name + avatar regardless of which provider variant sourced it.
--
-- Self-referential FK; ON DELETE SET NULL so deleting a canonical audience does
-- not cascade-delete the deprecated row (it just loses its link). NULL for every
-- non-deprecated / unlinked row.
ALTER TABLE "audiences"
  ADD COLUMN IF NOT EXISTS "canonical_audience_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audiences_canonical_audience_id_fkey'
  ) THEN
    ALTER TABLE "audiences"
      ADD CONSTRAINT "audiences_canonical_audience_id_fkey"
      FOREIGN KEY ("canonical_audience_id") REFERENCES "audiences"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_audiences_canonical"
  ON "audiences" ("canonical_audience_id");
