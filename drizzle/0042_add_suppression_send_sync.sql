-- RECONTACT-LOOP-1011: the per-brand re-contact window must run from the last
-- REAL EMAIL, not only from the last serve. A serve and its email are separated
-- by lead-service's sending queue (Perky 2026-07: served 07-01..07-11, emailed
-- 07-16), so a window anchored on the serve lapsed days before instantly-service's
-- own 3-month window (anchored on the send) did. The gateway then re-served people
-- instantly-service refuses to email (409 recent_brand_contact) and the campaign
-- looped on them. src/services/send-suppression-sync.ts copies every real send
-- from instantly-service's outreach fact feed onto the suppression row.
--
-- last_sent_at: the latest real email instantly-service sent this person for the
-- brand (evidence, NULL = no send copied). last_served_at stays THE window anchor
-- every read path uses, and the sync moves it to GREATEST(last_served_at, sent).
ALTER TABLE "brand_suppressions" ADD COLUMN IF NOT EXISTS "last_sent_at" timestamp with time zone;

-- The fact-feed cursor (instantly-service `seq`, exclusive). One row per feed.
CREATE TABLE IF NOT EXISTS "suppression_send_sync_state" (
  "feed" text PRIMARY KEY NOT NULL,
  "cursor" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
