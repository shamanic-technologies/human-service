-- Proof that the people shown in an audience's free preview can actually be
-- REACHED: for a few sampled people, the billed Apollo reveal was run and the
-- revealed email verified (apollo-service owns both calls and their cost).
-- One row per (audience, sample position). The address itself is never stored
-- here, only its domain and the verifier's verdict. A row at status 'checking'
-- is a claim taken BEFORE the spend, so two concurrent callers never pay for
-- the same person. Keyed on the audience (org via the audience row), so it
-- follows the audience on delete and on a brand transfer. Idempotent.
CREATE TABLE IF NOT EXISTS "audience_preview_email_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "person_index" integer NOT NULL,
  "provider_person_id" text NOT NULL,
  "status" text NOT NULL,
  "finder" text,
  "verifier" text,
  "verdict" text,
  "deliverable" boolean,
  "email_domain" text,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "checked_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_preview_email_checks_unique"
  ON "audience_preview_email_checks" ("audience_id", "person_index");
