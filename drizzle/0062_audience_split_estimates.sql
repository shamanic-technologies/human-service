-- AUDIENCE-COUNT-MISMATCH-1122: the filters a split card was COUNTED on, so the
-- audience a picked card creates is built on exactly those filters (same
-- population, same count). One row per measured segment; read by the confirm.
CREATE TABLE IF NOT EXISTS "audience_split_estimates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "name_norm" text NOT NULL,
  "description" text NOT NULL,
  "filters" jsonb NOT NULL,
  "people" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_audience_split_estimates_segment"
  ON "audience_split_estimates" ("org_id", "brand_id", "name_norm", "created_at" DESC);
