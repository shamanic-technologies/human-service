-- AUDIENCE-PER-OFFER-1107 (owner 2026-11-07): ONE audience per offer, its text the
-- offer's; the lists that find people (Apollo searches, signals, CRM files) belong
-- to the BRAND and serve every offer of it, Jev judging each person against each
-- offer's text.
--   role = 'target' : THE audience of its offer (text only, no list of its own).
--   role = 'search' : a list of the brand (a former audience row): never listed as
--                     an audience by default, walked by every target of its brand.
--   role IS NULL    : an audience as before (no target on its offer yet).
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "role" text;
-- One live target per offer.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audiences_offer_target"
  ON "audiences" ("org_id", "brand_id", "offer_id")
  WHERE "role" = 'target' AND "status" <> 'deprecated';
CREATE INDEX IF NOT EXISTS "idx_audiences_brand_role" ON "audiences" ("org_id", "brand_id", "role");
-- The brand list (search row + its source) that found a target's candidate.
ALTER TABLE "audience_candidates" ADD COLUMN IF NOT EXISTS "search_audience_id" uuid;
ALTER TABLE "audience_candidates" ADD COLUMN IF NOT EXISTS "search_source_id" uuid;
-- Reversible realignment ledger: which rows were turned into searches / created as
-- targets, by which reason tag.
CREATE TABLE IF NOT EXISTS "offer_audience_realignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reason" text NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "audience_id" uuid NOT NULL,
  "action" text NOT NULL,
  "previous_role" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_offer_audience_realignments_unique"
  ON "offer_audience_realignments" ("reason", "audience_id", "action");
