-- FACTORY-P3 next outcomes (lead_found): a walk of an apollo audience's teasers in the stored walk script's words
-- (pages of teasers with the facts each free rule reads, the verdicts, the offer), on either path: a share of our own
-- walks (`service`, pages of one) and every stored-script walk (`script`). Bronze, append-only. Read only by
-- GET /internal/candidate-walks/recorded (workflow-service's case recorder). Personal data.
CREATE TABLE IF NOT EXISTS "candidate_walks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seq" bigserial NOT NULL,
  "org_id" uuid NOT NULL,
  "audience_id" uuid NOT NULL,
  "serve_run_id" text,
  "run_id" text,
  "path" text NOT NULL,
  "units" jsonb NOT NULL,
  "calls" jsonb NOT NULL,
  "candidate_id" text,
  "status" text NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "candidate_walks_path_check" CHECK ("path" IN ('service', 'script'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_candidate_walks_seq" ON "candidate_walks" ("seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_candidate_walks_created" ON "candidate_walks" ("created_at");
