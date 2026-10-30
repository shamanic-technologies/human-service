-- FACTORY-P3 next outcomes (audience_built): every audience split PROPOSAL in the stored split script's words (the
-- exact completion request and its parsed answer, the icon judgment), on either path. Bronze, append-only. Read only
-- by GET /internal/audience-splits/recorded (workflow-service's case recorder).
CREATE TABLE IF NOT EXISTS "audience_split_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seq" bigserial NOT NULL,
  "org_id" uuid NOT NULL,
  "caller_run_id" text,
  "run_id" text,
  "path" text NOT NULL,
  "target_audience" text NOT NULL,
  "allow_empty" boolean NOT NULL,
  "calls" jsonb NOT NULL,
  "proposal" jsonb,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audience_split_proposals_path_check" CHECK ("path" IN ('service', 'script'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_split_proposals_seq" ON "audience_split_proposals" ("seq");
