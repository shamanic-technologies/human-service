-- People gateway v1: per-brand cross-provider suppression (Bronze/Silver/Gold).
-- Bronze lead_serves = append-only serve event log (audit, silver rebuildable).
-- Silver brand_suppressions = canonical per (org, brand, person); the read
-- surface for apollo teaser filter / apify exclude-set / resolve-email block.
-- Window (3 months) enforced on read via last_served_at. No gold table.

CREATE TABLE IF NOT EXISTS "lead_serves" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "provider_person_id" text,
  "first_name" text,
  "last_name" text,
  "email" text,
  "linkedin_url" text,
  "company_domain" text,
  "campaign_id" text,
  "run_id" text,
  "served_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "brand_suppressions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "email_norm" text NOT NULL,
  "linkedin_url_norm" text,
  "provider_person_id" text,
  "last_provider" text,
  "first_served_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_served_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_lead_serves_org_brand" ON "lead_serves" ("org_id", "brand_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_lead_serves_served_at" ON "lead_serves" ("served_at");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_brand_suppressions_unique" ON "brand_suppressions" ("org_id", "brand_id", "email_norm");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_brand_suppressions_linkedin" ON "brand_suppressions" ("org_id", "brand_id", "linkedin_url_norm");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_brand_suppressions_person" ON "brand_suppressions" ("org_id", "brand_id", "provider_person_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_brand_suppressions_window" ON "brand_suppressions" ("org_id", "brand_id", "last_served_at");
