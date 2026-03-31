-- Migrate brand_id (single text) to brand_ids (text array) for multi-brand support
ALTER TABLE "human_methodologies" ADD COLUMN "brand_ids" text[];
UPDATE "human_methodologies" SET "brand_ids" = ARRAY["brand_id"] WHERE "brand_id" IS NOT NULL;
ALTER TABLE "human_methodologies" DROP COLUMN "brand_id";
