-- OUTREACH-3WAYS-1121: who an audience is TO THE BRAND beyond "buyers of offer X".
-- relation IS NULL       : buyers of the audience's offer (every audience until now).
-- relation = 'investors' : the brand's equity investors (angels, early-stage VCs).
-- relation = 'industry_peers' : founders and leaders of companies in the brand's
--                          industry, competitors included.
-- A relation audience is a TARGET with no offer (one live per brand x relation);
-- its lists (role 'search') carry the same relation and are walked only by it,
-- and an offer's target never walks a relation list.
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "relation" text;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audiences_relation_target"
  ON "audiences" ("org_id", "brand_id", "relation")
  WHERE "role" = 'target' AND "relation" IS NOT NULL AND "status" <> 'deprecated';
-- Reversible ledger of audiences turned into a relation (assign) or created for one
-- (ensure): previous relation / role / offer kept so /revert restores them verbatim.
CREATE TABLE IF NOT EXISTS "brand_relation_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reason" text NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "audience_id" uuid NOT NULL,
  "relation" text NOT NULL,
  "action" text NOT NULL,
  "previous_relation" text,
  "previous_role" text,
  "previous_offer_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_brand_relation_assignments_unique"
  ON "brand_relation_assignments" ("reason", "audience_id");
