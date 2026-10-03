-- One row per (org, brand, offer) launch of an ICP audience PORTFOLIO
-- (POST /orgs/audiences/portfolio): the cold split audiences plus one
-- buying-signal audience per signal whose coverage clears the bar. The row is
-- what makes the launch idempotent: a replay returns the recorded audiences and
-- signal outcomes instead of re-spending. `status` = 'building' while a launch
-- runs (a crashed one is resumed by the next call), 'ready' once finished.
CREATE TABLE IF NOT EXISTS "audience_portfolios" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "icp_text" text NOT NULL,
  "target" text,
  "status" text NOT NULL DEFAULT 'building',
  "cold_audience_ids" jsonb,
  "signals" jsonb,
  "icp_apollo_audience_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_portfolios_scope"
  ON "audience_portfolios" ("org_id", "brand_id", "offer_id");
