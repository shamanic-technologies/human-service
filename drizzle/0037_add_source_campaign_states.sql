-- SOURCE CAMPAIGNS (owner 2026-10-07): a lead SOURCE of an offer is a campaign of
-- campaign-service, keyed (offer, feature_slug = <origin slug>, leg_key =
-- 'start_to_lead_found'). Turning one ON means its origin's audience exists for the
-- offer and is active; OFF means it is paused (history kept).
-- src/services/source-campaigns.ts.
--
-- source_campaign_states: the last on/off this service APPLIED per (org, brand,
-- offer, origin). A transition is a change against this row, so a reconcile pass
-- acts once per real change and never on a state it already applied.
CREATE TABLE IF NOT EXISTS "source_campaign_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "origin_slug" text NOT NULL,
  "list_kind" text NOT NULL,
  "campaign_id" text,
  "status" text NOT NULL,
  "outcome" text,
  "outcome_reason" text,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_source_campaign_states_scope"
  ON "source_campaign_states" ("org_id", "brand_id", "offer_id", "origin_slug");
--> statement-breakpoint
-- source_campaign_audience_holds: every audience an OFF paused, so the next ON resumes
-- exactly those (never one a person paused or archived). A hold is released by the ON
-- (released_at), or left as history when a person changed the audience since.
CREATE TABLE IF NOT EXISTS "source_campaign_audience_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "origin_slug" text NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "campaign_id" text,
  "held_at" timestamp with time zone DEFAULT now() NOT NULL,
  "released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_source_campaign_audience_holds_scope"
  ON "source_campaign_audience_holds" ("org_id", "brand_id", "offer_id", "origin_slug");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_source_campaign_audience_holds_open"
  ON "source_campaign_audience_holds" ("audience_id") WHERE released_at IS NULL;
