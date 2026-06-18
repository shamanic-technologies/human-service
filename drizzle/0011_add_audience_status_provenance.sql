-- Audiences gain a status lifecycle mirroring brand-service persona semantics,
-- a provenance tag for the one-time persona->audience backfill, and a
-- name-unique-per-brand constraint. Idempotent (ADD COLUMN / CREATE INDEX IF
-- NOT EXISTS). Existing rows default to status 'active' via the column default.
--
-- status: 'active' | 'paused' | 'archived' (default active). The only mutable
--   field on an audience (editing filters = a new audience). Archived is a soft
--   state, never a hard delete.
-- source: provenance marker. 'brand_persona_backfill' for backfilled rows (so
--   they can be identified and undone: DELETE FROM audiences WHERE
--   source = 'brand_persona_backfill'); null for natively-created rows.

ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint
-- Name-unique per brand, case-insensitive (mirrors brand-service
-- brand_personas_brand_id_lower_name_key). Prod audiences = 0 rows at migration
-- time, so no dedup step is required.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audiences_brand_lower_name" ON "audiences" ("brand_id", lower("name"));
