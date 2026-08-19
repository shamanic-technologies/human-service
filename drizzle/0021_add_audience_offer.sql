-- An audience belongs to ONE offer, not to a whole brand.
--
-- The platform inserts an OFFER level between Brand and Campaign
-- (Org > Brand > Offer > Campaign): one distinct thing a brand sells. An
-- audience is assembled for a specific promise — the CFO list built to sell a
-- $20k enterprise contract is not the list you send a $200 self-serve plan to —
-- so it is scoped to the offer rather than to every offer the brand runs.
--
-- brand-service owns the offer entity and exposes it as a UUID. human-service
-- records the pointer and nothing else: no offer semantics, no cross-service
-- lookup. That mirrors `brand_id` (also an id owned elsewhere, also stored
-- unvalidated) rather than `crm_upload_id`, which is validated because it
-- decides which people a serve may reach.
--
-- Nullable, and NULL is the pre-existing world: an audience carrying no offer
-- lists, serves and collides exactly as it does today.
ALTER TABLE audiences ADD COLUMN IF NOT EXISTS offer_id uuid;

CREATE INDEX IF NOT EXISTS idx_audiences_offer_id
  ON audiences (offer_id);
--> statement-breakpoint

-- Name uniqueness moves from (org, brand, lower(name)) to
-- (org, brand, offer, lower(name)) — as TWO PARTIAL indexes, not one
-- four-column index. Postgres treats NULLs as distinct, so a plain
-- (org, brand, offer_id, lower(name)) unique index would let two offer-less
-- audiences share a name, silently loosening the constraint every existing row
-- lives under. The offer-less half therefore keeps the old index definition
-- verbatim, merely restricted to `offer_id IS NULL`.
--
-- Purely additive by construction: every row today has offer_id NULL and so
-- falls under an index identical to the one being replaced, which is why the
-- DROP/CREATE cannot conflict with existing data.
DROP INDEX IF EXISTS "idx_audiences_org_brand_lower_name";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audiences_org_brand_lower_name"
  ON "audiences" ("org_id", "brand_id", lower("name"))
  WHERE "offer_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audiences_org_brand_offer_lower_name"
  ON "audiences" ("org_id", "brand_id", "offer_id", lower("name"))
  WHERE "offer_id" IS NOT NULL;
