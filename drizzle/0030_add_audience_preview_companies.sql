-- The companies an audience reaches, with firmographics and the one person to
-- write to at each: up to 100 rows per audience, built progressively (a chunk
-- per call) from apollo-service and kept here so a reload never re-pays for
-- them. `idx` is the stable 0-based rank. `person` keeps the provider's reveal
-- handle, which the API never returns. Never an email or a phone. Keyed on the
-- audience (org via the audience row), so it follows the audience on delete and
-- on a brand transfer. Idempotent.
CREATE TABLE IF NOT EXISTS "audience_preview_companies" (
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "idx" integer NOT NULL,
  "company" jsonb NOT NULL,
  "person" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("audience_id", "idx")
);
-- Where the build stands: the provider's opaque cursor for the next chunk,
-- whether the audience ran out (or hit the 100 cap), and the terminal
-- empty/unavailable answer when there is one. NULL = never built.
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "preview_companies_state" jsonb;
-- Email checks now cover two lists: the 5-person /preview sample ('preview',
-- every existing row) and the company rows of /preview/companies
-- ('companies', person_index = the row's index). Uniqueness moves to
-- (audience, sample, position) so the two never collide.
ALTER TABLE "audience_preview_email_checks" ADD COLUMN IF NOT EXISTS "sample" text DEFAULT 'preview' NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_preview_email_checks_sample_unique"
  ON "audience_preview_email_checks" ("audience_id", "sample", "person_index");
DROP INDEX IF EXISTS "idx_audience_preview_email_checks_unique";
