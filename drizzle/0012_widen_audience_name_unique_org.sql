-- Widen the audience name-uniqueness from (brand_id, lower(name)) to
-- (org_id, brand_id, lower(name)). The suggest flow (POST /orgs/audiences/
-- suggest) persists candidate audiences keyed on org+brand+name, and the same
-- audience name must be allowed for the same brand across different orgs (org
-- isolation). This is a pure LOOSENING: any row that satisfied the stricter
-- brand-scoped constraint still satisfies the org+brand-scoped one, so the swap
-- can never conflict with existing data. Idempotent (DROP/CREATE IF [NOT] EXISTS).

DROP INDEX IF EXISTS "idx_audiences_brand_lower_name";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audiences_org_brand_lower_name" ON "audiences" ("org_id", "brand_id", lower("name"));
