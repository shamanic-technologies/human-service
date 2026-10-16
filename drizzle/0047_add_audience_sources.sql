-- AUDIENCE-SOURCES-1016 (owner 2026-10-16): a SOURCE is not an AUDIENCE.
-- An audience is WHO (one target text). Its sources are WHERE we look for them
-- (a buying signal, competitor-post engagement), stored BESIDE it, one row per
-- (audience, source kind). The audience's OWN list (its own filters / pointer)
-- stays on the audience row; its on/off is `audiences.own_source_status`.
-- src/services/audience-sources.ts.
CREATE TABLE IF NOT EXISTS "audience_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "list" text NOT NULL,
  "signal_type" text,
  "window_days" integer,
  "name" text NOT NULL,
  "apollo_audience_id" text,
  "filters" jsonb,
  "apollo_count" integer,
  "counted_at" timestamptz,
  "reachable_count" integer,
  "status" text DEFAULT 'active' NOT NULL,
  "status_reason" text,
  "status_set_at" timestamptz,
  "exhausted_at" timestamptz,
  "last_served_at" timestamptz,
  "legacy_audience_id" uuid,
  "created_by_user_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_sources_kind" ON "audience_sources" ("audience_id", "list", coalesce("signal_type", ''));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_sources_legacy" ON "audience_sources" ("legacy_audience_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audience_sources_scope" ON "audience_sources" ("org_id", "brand_id", "offer_id");
--> statement-breakpoint
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "own_source_status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
-- An audience a source campaign OFF paused and holds has its OWN list off.
UPDATE "audiences" SET "own_source_status" = 'paused'
 WHERE "id" IN (SELECT "audience_id" FROM "source_campaign_audience_holds" WHERE "released_at" IS NULL);
--> statement-breakpoint
-- Which source of the audience a row came from. NULL = the audience's own list
-- (every row written before this migration).
ALTER TABLE "audience_teaser_buffer" ADD COLUMN IF NOT EXISTS "source_id" uuid;
--> statement-breakpoint
ALTER TABLE "audience_teaser_screenings" ADD COLUMN IF NOT EXISTS "source_id" uuid;
--> statement-breakpoint
ALTER TABLE "audience_candidates" ADD COLUMN IF NOT EXISTS "source_id" uuid;
--> statement-breakpoint
ALTER TABLE "lead_serves" ADD COLUMN IF NOT EXISTS "audience_source_id" uuid;
--> statement-breakpoint
-- Per-source provenance: every source of an audience that FOUND a person (served
-- or found already taken). A person found by two sources carries both rows.
-- source_id NULL = the audience's own list.
CREATE TABLE IF NOT EXISTS "audience_member_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE CASCADE,
  "source_id" uuid,
  "provenance" text DEFAULT 'served' NOT NULL,
  "first_found_at" timestamptz DEFAULT now() NOT NULL,
  "last_found_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_member_sources_unique" ON "audience_member_sources" ("audience_id", "person_id", coalesce("source_id", '00000000-0000-0000-0000-000000000000'::uuid));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audience_member_sources_source" ON "audience_member_sources" ("source_id");
--> statement-breakpoint
-- Reversible ledger of the one-time merge of per-source audience rows
-- (POST /internal/merge-source-audiences): one row per merged child, with what it
-- was before, so /revert restores it exactly.
CREATE TABLE IF NOT EXISTS "audience_source_merges" (
  "child_audience_id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "target_audience_id" uuid NOT NULL,
  "source_id" uuid NOT NULL,
  "prior_status" text NOT NULL,
  "prior_status_set_by" text,
  "prior_status_set_reason" text,
  "prior_status_set_by_user_id" uuid,
  "prior_status_set_at" timestamptz,
  "prior_canonical_audience_id" uuid,
  "moved_buffer" integer DEFAULT 0 NOT NULL,
  "copied_screened_out" integer DEFAULT 0 NOT NULL,
  "target_resumed" boolean DEFAULT false NOT NULL,
  "released_hold_ids" jsonb,
  "merged_at" timestamptz DEFAULT now() NOT NULL
);
