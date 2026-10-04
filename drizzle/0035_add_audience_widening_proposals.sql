-- The audience refill's WIDENING proposals (src/services/audience-refill.ts).
-- When nobody new is left inside the target a client validated, the refill no
-- longer creates active audiences outside it: it stores the wider target and
-- the segments it would add, for the client to accept or decline. Nothing in a
-- pending proposal is contacted. At most one pending proposal per
-- (org, brand, offer).
CREATE TABLE IF NOT EXISTS "audience_widening_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "base_target" text NOT NULL,
  "widened_target" text NOT NULL,
  "segments" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "created_by_user_id" uuid,
  "decided_at" timestamp with time zone,
  "decided_by_user_id" text,
  "created_audience_ids" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audience_widening_proposals_brand"
  ON "audience_widening_proposals" ("org_id", "brand_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_widening_proposals_one_pending"
  ON "audience_widening_proposals" ("org_id", "brand_id", "offer_id") WHERE status = 'pending';
