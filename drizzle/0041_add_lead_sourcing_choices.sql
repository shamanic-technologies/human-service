-- LEAD SOURCING (owner 2026-10-11): the sourcing channel that PICKS its origins. A sales funnel names ONE
-- channel on Start -> Lead found: one origin, or Lead Sourcing, where THIS service decides which origins the
-- brand uses (src/services/lead-sourcing.ts).
--
-- lead_sourcing_choices: the current decision per (org, brand, offer). `universe_origin_slugs` = the origins it
-- may choose among (the ones the brand already had ON when it switched, else every origin Lead Sourcing may
-- use), `chosen_origin_slugs` = the ones it uses now (measured ROI within the universe), `reasons` = per origin,
-- why, with the evidence read.
CREATE TABLE IF NOT EXISTS "lead_sourcing_choices" (
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "campaign_id" text,
  "basis" text NOT NULL,
  "universe_origin_slugs" text[] NOT NULL,
  "chosen_origin_slugs" text[] NOT NULL,
  "reasons" jsonb NOT NULL,
  "evidence_at" timestamp with time zone,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "lead_sourcing_choices_pk" PRIMARY KEY ("org_id", "brand_id", "offer_id")
);
--> statement-breakpoint
-- Every change of the chosen set, append-only (who stopped or started using which origin, and why).
CREATE TABLE IF NOT EXISTS "lead_sourcing_choice_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "from_origin_slugs" text[],
  "to_origin_slugs" text[] NOT NULL,
  "reasons" jsonb NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lead_sourcing_choice_changes_scope" ON "lead_sourcing_choice_changes" ("org_id", "brand_id", "offer_id", "changed_at");
