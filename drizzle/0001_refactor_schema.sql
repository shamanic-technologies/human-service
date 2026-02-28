-- Drop old schema
DROP TABLE IF EXISTS "human_profiles";
DROP INDEX IF EXISTS "idx_profiles_app_org";

-- Orgs (multi-tenant registry)
CREATE TABLE "orgs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "app_id" text NOT NULL,
  "org_id" text NOT NULL,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX "idx_orgs_app_org_id" ON "orgs" ("app_id", "org_id");

-- Users
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_internal_id" uuid NOT NULL REFERENCES "orgs" ("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX "idx_users_org_user" ON "users" ("org_internal_id", "user_id");

-- Humans (primary entity)
CREATE TABLE "humans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_internal_id" uuid NOT NULL REFERENCES "orgs" ("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "bio" text,
  "expertise" text[],
  "known_for" text,
  "image_url" text,
  "urls" text[] NOT NULL,
  "max_pages" integer NOT NULL DEFAULT 10,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "idx_humans_org_slug" ON "humans" ("org_internal_id", "slug");
CREATE INDEX "idx_humans_org" ON "humans" ("org_internal_id");

-- Human methodologies (1:1 with humans, AI-extracted, cached with TTL)
CREATE TABLE "human_methodologies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "human_id" uuid NOT NULL UNIQUE REFERENCES "humans" ("id") ON DELETE CASCADE,
  "frameworks" jsonb,
  "strategic_patterns" text[],
  "tone_of_voice" jsonb,
  "persuasion_style" jsonb,
  "content_signatures" text[],
  "avoids" text[],
  "extraction_model" text,
  "source_urls" text[],
  "extracted_at" timestamptz DEFAULT now(),
  "expires_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "idx_methodologies_human" ON "human_methodologies" ("human_id");
