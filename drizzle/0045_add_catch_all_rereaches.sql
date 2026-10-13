-- CATCHALL-SERVE-OPTION-1013: a serve asking `acceptedEmails: "valid_and_catch_all"`
-- re-reaches the catch-all people a brand already paid to reveal and verify, and
-- dropped (src/services/catch-all-rereach.ts). This ledger hands each one out ONCE
-- per (org, brand, address), whichever path or audience. `lead_serve_id` = the
-- paid serve whose address and verdict are reused (no new reveal, no new check).
-- status: claimed | offered | handed | blocked | declined.
CREATE TABLE IF NOT EXISTS "catch_all_rereaches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "audience_id" uuid NOT NULL,
  "email_norm" text NOT NULL,
  "provider_person_id" text NOT NULL,
  "lead_serve_id" uuid NOT NULL,
  "path" text NOT NULL,
  "status" text NOT NULL,
  "block_reason" text,
  "candidate_id" uuid,
  "previous_reveal_result" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "decided_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_catch_all_rereaches_unique" ON "catch_all_rereaches" ("org_id", "brand_id", "email_norm");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_catch_all_rereaches_candidate" ON "catch_all_rereaches" ("candidate_id");
--> statement-breakpoint
-- The re-reach read walks one audience's catch-all serves, and checks a later
-- non-catch-all verdict on the same address: both partial, both small.
CREATE INDEX IF NOT EXISTS "idx_lead_serves_catch_all_audience" ON "lead_serves" ("org_id", "brand_id", "audience_id", "served_at") WHERE "email_verdict" = 'catch_all';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_serves_verdict_email" ON "lead_serves" ("org_id", "brand_id", lower(btrim("email"))) WHERE "email_verdict" IS NOT NULL;
