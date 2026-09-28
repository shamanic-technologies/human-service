-- A free sample of who an audience reaches (real companies + real people, no
-- emails), fetched once from the provider and kept on the row so a reloading
-- visitor never re-asks the provider. Nullable, no default: NULL is "never
-- previewed". Idempotent.
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "preview" jsonb;
