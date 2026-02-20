CREATE TABLE IF NOT EXISTS "human_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"org_id" text,
	"user_id" text,
	"name" text NOT NULL,
	"urls" text[] NOT NULL,
	"scraped_pages" jsonb,
	"max_pages" integer DEFAULT 3 NOT NULL,
	"writing_style" text,
	"bio" text,
	"topics" text[],
	"tone" text,
	"vocabulary" text,
	"last_scraped_at" timestamp with time zone,
	"cache_ttl_hours" integer DEFAULT 24 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_profiles_app_org" ON "human_profiles" USING btree ("app_id","org_id");