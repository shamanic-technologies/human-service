-- Remove appId, local org/user tables; store org_id directly on humans

-- Step 1: Add org_id text column to humans
ALTER TABLE "humans" ADD COLUMN "org_id" text;

-- Step 2: Populate org_id from orgs join
UPDATE "humans" h
SET "org_id" = o."org_id"
FROM "orgs" o
WHERE h."org_internal_id" = o."id";

-- Step 3: Make org_id NOT NULL
ALTER TABLE "humans" ALTER COLUMN "org_id" SET NOT NULL;

-- Step 4: Drop old FK constraint and column
ALTER TABLE "humans" DROP CONSTRAINT IF EXISTS "humans_org_internal_id_orgs_id_fk";
DROP INDEX IF EXISTS "idx_humans_org_slug";
DROP INDEX IF EXISTS "idx_humans_org";
ALTER TABLE "humans" DROP COLUMN "org_internal_id";

-- Step 5: Add new indexes using org_id
CREATE UNIQUE INDEX "idx_humans_org_slug" ON "humans" ("org_id", "slug");
CREATE INDEX "idx_humans_org" ON "humans" ("org_id");

-- Step 6: Drop users and orgs tables
DROP TABLE IF EXISTS "users";
DROP TABLE IF EXISTS "orgs";
