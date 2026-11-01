-- BLANK-CANDIDATES-1101: candidates offered for judgment with no facts about the person (teaser NULL) were declined by
-- a judge that saw nothing. The repair (POST /internal/rejudge-blank-candidates) re-offers each with the person's
-- stored teaser; this ledger keeps what it changed (the candidate as it was, the rejection it lifted) so `/revert`
-- puts it back. No org_id: it follows its audience (cascade), like audience_preview_email_checks.
CREATE TABLE IF NOT EXISTS "candidate_rejudges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reason" text NOT NULL,
  "candidate_id" uuid NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "previous" jsonb NOT NULL,
  "screened_out" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_candidate_rejudges_unique" ON "candidate_rejudges" ("reason", "candidate_id");
--> statement-breakpoint
-- The person's stored teaser is looked up by apollo person id alone (any audience): key-only indexes.
CREATE INDEX IF NOT EXISTS "idx_audience_teaser_screenings_person" ON "audience_teaser_screenings" ("provider_person_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audience_candidates_person" ON "audience_candidates" ("provider_person_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audience_teaser_buffer_person" ON "audience_teaser_buffer" ("provider_person_id");
