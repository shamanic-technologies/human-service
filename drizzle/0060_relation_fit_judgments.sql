-- OUTREACH-3WAYS-1121 (src/services/relation-fit.ts): does a person found by a brand-relation list
-- belong to that relation? Industry peers: is the person's COMPANY in the brand's industry (one row per
-- company). Investors: does the PERSON invest in companies (one row per person). One Jev judgment each,
-- judged once and persisted, read before anyone is offered to the relation's audience.
CREATE TABLE IF NOT EXISTS "relation_fit_judgments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "relation" text NOT NULL,
  "subject_key" text NOT NULL,
  "prompt_version" text NOT NULL,
  "verdict" boolean NOT NULL,
  "yes_probability" double precision NOT NULL,
  "model" text NOT NULL,
  "facts" jsonb NOT NULL,
  "population" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_relation_fit_judgments_subject"
  ON "relation_fit_judgments" ("org_id", "brand_id", "relation", "subject_key", "prompt_version");
