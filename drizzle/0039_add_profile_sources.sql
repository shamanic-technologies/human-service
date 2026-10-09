-- PROFILE x SOURCE (owner 2026-10-09). A client profile (a cold audience: "Heads of
-- QA") says WHO; a source (a buying signal, competitor-post engagement) says WHERE we
-- find them. The lists a source serves are one audience per (profile, source), so
-- pausing a profile stops every list of its people. src/services/profile-sources.ts.
--
-- audiences.profile_audience_id: the profile a source list was built for. NULL on a
-- profile itself, on a list built before this column (the whole-ICP signal lists,
-- retired by the first profile build of their offer) and on every other audience.
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "profile_audience_id" uuid REFERENCES "audiences"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audiences_profile" ON "audiences" ("profile_audience_id");
--> statement-breakpoint
-- audience_profile_holds: every source list a person's pause of its profile held, so
-- resuming the profile resumes exactly those (never one a person paused, nor one a
-- source campaign OFF still holds). Released by the resume (released_at).
CREATE TABLE IF NOT EXISTS "audience_profile_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "profile_audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "held_at" timestamp with time zone DEFAULT now() NOT NULL,
  "released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audience_profile_holds_profile" ON "audience_profile_holds" ("profile_audience_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_profile_holds_open" ON "audience_profile_holds" ("audience_id") WHERE released_at IS NULL;
