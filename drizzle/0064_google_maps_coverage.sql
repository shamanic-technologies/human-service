-- GMAPS-COVERAGE-1126 (src/services/google-maps-coverage.ts): a Google Maps list whose searches all ran asks for
-- the next searches (finer areas where a search hit the provider's result ceiling, towns of the target region not
-- searched yet) instead of answering exhausted. One row per extension round of a list: the claim (status
-- 'drafting'), then what the round decided ('extended' with its searches, or 'covered' with the reason).
-- No org_id: the org is the list's (cascades with it, follows it through a brand transfer).
CREATE TABLE IF NOT EXISTS "google_maps_coverage_rounds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "round" integer NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "region_text" text,
  "queries" jsonb,
  "run_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_google_maps_coverage_rounds_round"
  ON "google_maps_coverage_rounds" ("audience_id", "round");
ALTER TABLE "google_maps_queries" ADD COLUMN IF NOT EXISTS "coverage_round" integer DEFAULT 0 NOT NULL;
