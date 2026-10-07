-- Candidate API (src/services/audience-candidates.ts): lead-service takes over
-- the pre-pay qualification of a person, so a FREE teaser is handed out as a
-- candidate BEFORE any reveal is bought, then revealed (paid, served exactly as
-- serve-next) or declined (never offered again for that audience; leaves the
-- pool like a screened-out person). One row per (audience, apollo person): the
-- decision ledger, and the bronze the candidate path's yield is read from.
ALTER TABLE "audience_teaser_buffer" ADD COLUMN IF NOT EXISTS "organization_domain" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audience_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "provider_person_id" text NOT NULL,
  "linkedin_url" text,
  "teaser" jsonb,
  "organization_domain" text,
  "status" text NOT NULL DEFAULT 'offered',
  "decline_reason" text,
  "basis" text,
  "reveal_result" jsonb,
  "offered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_candidates_unique"
  ON "audience_candidates" ("audience_id", "provider_person_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audience_candidates_open"
  ON "audience_candidates" ("audience_id", "status", "offered_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audience_candidates_decided"
  ON "audience_candidates" ("audience_id", "decided_at" DESC);
