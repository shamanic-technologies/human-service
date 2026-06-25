-- "One filter vocabulary" Wave 2: human-service stops holding Apollo's filter
-- vocabulary. An apollo audience now stores a POINTER to a faithful Apollo
-- audience owned by apollo-service (built + counted there via its agentic
-- NL->faithful-filters loop). human-service stays the NEUTRAL cross-provider
-- layer; the faithful filters live in apollo-service and are SOURCED by id.
--
-- `apollo_audience_id` is nullable: native apify audiences (legacy/inert) and
-- pre-Wave-2 rows have none until the one-time
-- POST /internal/backfill-apollo-audience-pointers sweep fills them. The
-- existing `filters` jsonb column is KEPT but, for apollo rows, now caches the
-- OPAQUE faithful Apollo filter object returned by apollo-service (no human-side
-- schema/validation on it anymore) — so serve-next can forward it verbatim to
-- apollo /search without a neutral->apollo remap.
ALTER TABLE "audiences"
  ADD COLUMN IF NOT EXISTS "apollo_audience_id" text;

-- The backfill sweep scans `provider='apollo' AND apollo_audience_id IS NULL`,
-- so index the pointer for the (small) lookup + future by-pointer reads.
CREATE INDEX IF NOT EXISTS "idx_audiences_apollo_audience_id"
  ON "audiences" ("apollo_audience_id");
