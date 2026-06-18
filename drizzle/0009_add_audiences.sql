-- People gateway v1: audiences (saved persona/ICP filter-set) + canonical
-- people dedup + audience membership bridge (Bronze/Silver/Gold).
--
-- Naming follows CDP/CRM canon (Segment / Salesforce CDP / Adobe AEP / HubSpot):
--   audience        = a saved filter-set whose membership is computed dynamically
--                     ("dynamic audience"). NOT "persona" — in CDP canon persona
--                     is the trait-assignment layer ABOVE audiences; NOT
--                     "database_search" — that names the mechanism, not the thing.
--   people          = the canonical, deduped person dimension (silver). The
--                     legacy `humans` table is expert-profiles (a different
--                     concept), so the canonical person entity is `people`.
--   audience_members = the Kimball BRIDGE table resolving the many-to-many
--                     person<->audience relation. Carries effective dates
--                     (joined_at / last_served_at) per Kimball bridge guidance
--                     so point-in-time membership is answerable.
--
-- Membership is PROVENANCE-based: a person joins an audience iff a serve made
-- while that audience was named returned them (no local re-implementation of
-- provider matching). One person accrues many audiences over time.
--
-- org_id / brand_id are uuid (new-table convention); source is text (provider).
-- Idempotent: CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

-- 🥈 Silver — canonical, deduped person dimension (per org). Dedup keys:
-- email_norm (canonical) then linkedin_url_norm then apollo/apify person id.
-- Non-partial unique index on (org_id, email_norm): email_norm is nullable,
-- Postgres treats NULLs as distinct (multiple email-less rows allowed) AND
-- ON CONFLICT (org_id, email_norm) can infer it (no 42P10 partial-index trap).
CREATE TABLE IF NOT EXISTS "people" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "email_norm" text,
  "linkedin_url_norm" text,
  "apollo_person_id" text,
  "apify_person_id" text,
  "first_name" text,
  "last_name" text,
  "full_name" text,
  "company_domain" text,
  "company_name" text,
  "title" text,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- 🥈 Silver — audience = saved neutral filter-set + per-provider count snapshot.
-- The gateway's neutral PeopleSearchFilters maps to BOTH providers, so one
-- filter set drives two counts (the same filters match a different number of
-- people in each provider's DB).
CREATE TABLE IF NOT EXISTS "audiences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "name" text NOT NULL,
  "nl_prompt" text,
  "filters" jsonb,
  "apollo_count" integer,
  "apify_count" integer,
  "counted_at" timestamp with time zone,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- 🥈 Silver — Kimball bridge: person <-> audience (many-to-many). One row per
-- (audience, person). confidence='provider_confirmed' (joined because a serve
-- for this audience returned them). joined_at = effective date; last_served_at
-- = most recent serve under this audience.
CREATE TABLE IF NOT EXISTS "audience_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE CASCADE,
  "source" text,
  "confidence" text DEFAULT 'provider_confirmed' NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_served_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- 🥉 Bronze — link each serve to the audience it was served under (audit).
ALTER TABLE "lead_serves" ADD COLUMN IF NOT EXISTS "audience_id" uuid;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_people_org_email" ON "people" ("org_id", "email_norm");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_people_org_linkedin" ON "people" ("org_id", "linkedin_url_norm");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_people_org_apollo" ON "people" ("org_id", "apollo_person_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_people_org_apify" ON "people" ("org_id", "apify_person_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audiences_org_brand" ON "audiences" ("org_id", "brand_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_members_unique" ON "audience_members" ("audience_id", "person_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audience_members_org" ON "audience_members" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audience_members_person" ON "audience_members" ("person_id");
