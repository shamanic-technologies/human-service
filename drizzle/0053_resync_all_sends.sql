-- FRESH-NEVER-1106: a serve stating excludeEmailedWithin 'never' refuses every
-- person the brand EVER emailed, read off brand_suppressions.last_sent_at. Until
-- now the send sync (src/services/send-suppression-sync.ts) skipped sends older
-- than 3 months, so last_sent_at is missing for people emailed before that. The
-- sync now copies every send; re-walk the feed once from the start. Idempotent:
-- GREATEST never moves a window back, and an old send's row is created already
-- lapsed for every interval window.
UPDATE "suppression_send_sync_state" SET "cursor" = 0, "updated_at" = now() WHERE "feed" = 'instantly-outreach-facts';
