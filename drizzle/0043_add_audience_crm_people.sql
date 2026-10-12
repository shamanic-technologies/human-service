-- A CRM audience can draw from crm-service's merged PEOPLE pool (the brand's
-- signups, CRM, mailbox, WhatsApp... one row per human) under a filter, instead
-- of from one imported file. crm_people_filter = {signedUp?, replied?,
-- reachableBy?} sent verbatim as `people` on crm-service serve-next; NULL = not
-- people-bound (every existing row: unchanged behaviour). crm_people_stats =
-- crm-service serve-stats for that filter, the audience's Size / Remaining.
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "crm_people_filter" jsonb;
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "crm_people_stats" jsonb;
