-- Add org_id to human_methodologies for direct org scoping (enables brand transfer)
ALTER TABLE "human_methodologies" ADD COLUMN "org_id" text;

-- Backfill org_id from the parent humans table
UPDATE "human_methodologies" hm
SET "org_id" = h."org_id"
FROM "humans" h
WHERE hm."human_id" = h."id";

-- Add index for transfer-brand lookups
CREATE INDEX "idx_methodologies_org_brand" ON "human_methodologies" ("org_id");
