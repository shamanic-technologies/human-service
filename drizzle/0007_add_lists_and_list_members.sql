-- CRM v1: lists + list_members
-- Org-scoped curated contact lists. v1 references contacts via
-- (source_service, source_resource_id) string pointer (no FK across services).

CREATE TABLE "lists" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid,
  "name" text NOT NULL,
  "description" text,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "list_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "list_id" uuid NOT NULL,
  "source_service" text DEFAULT 'google-service' NOT NULL,
  "source_resource_id" text NOT NULL,
  "source_account_id" uuid,
  "human_id" uuid,
  "added_by_user_id" uuid,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "list_members_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "lists"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX "idx_lists_org" ON "lists" ("org_id");
--> statement-breakpoint

CREATE INDEX "idx_lists_brand" ON "lists" ("brand_id") WHERE "brand_id" IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX "idx_list_members_unique" ON "list_members" ("list_id", "source_service", "source_resource_id");
--> statement-breakpoint

CREATE INDEX "idx_list_members_org" ON "list_members" ("org_id");
--> statement-breakpoint

CREATE INDEX "idx_list_members_list" ON "list_members" ("list_id");
