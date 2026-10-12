-- WHO set an audience's current status (LEAK-1012, owner 2026-10-12): an audience a
-- PERSON paused is never un-paused by a product path (source turn-on, profile resume,
-- sweeps). status_set_by = 'person' | 'system'; NULL = not recorded, which every
-- automatic resume treats as a person's pause (never auto-unpause what we cannot
-- prove the system paused).
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "status_set_by" text;
--> statement-breakpoint
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "status_set_reason" text;
--> statement-breakpoint
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "status_set_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "status_set_at" timestamptz;
--> statement-breakpoint
-- Recorded facts only: a paused row an OPEN source-campaign hold holds was paused by
-- that OFF (a person's PATCH closes the row's holds; prod 2026-10-13: no held row was
-- written after its hold). Same for an open profile hold (the profile cascade).
-- Every other paused row stays NULL = unknown = a person's.
UPDATE "audiences" a
   SET "status_set_by" = 'system', "status_set_reason" = 'source_campaign_off', "status_set_at" = h.held_at
  FROM (SELECT audience_id, min(held_at) AS held_at FROM "source_campaign_audience_holds"
         WHERE released_at IS NULL GROUP BY audience_id) h
 WHERE a.id = h.audience_id AND a.status = 'paused' AND a.status_set_by IS NULL;
--> statement-breakpoint
UPDATE "audiences" a
   SET "status_set_by" = 'system', "status_set_reason" = 'profile_paused', "status_set_at" = h.held_at
  FROM (SELECT audience_id, min(held_at) AS held_at FROM "audience_profile_holds"
         WHERE released_at IS NULL GROUP BY audience_id) h
 WHERE a.id = h.audience_id AND a.status = 'paused' AND a.status_set_by IS NULL;
