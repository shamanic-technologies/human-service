-- A CRM audience can be bound to exactly ONE of the brand's imported CRM sources
-- (a crm-service upload) instead of meaning "this brand's entire imported list".
-- Several such audiences may coexist for one brand, each behaving as its own
-- audience: pausing one stops sending to the people of that file only, and
-- outreach economics are attributed per file rather than lumped brand-wide.
--
-- Typed first-class pointer, NOT a filter: an imported-source id is a provider
-- resource pointer (same shape as apollo_audience_id), not a search predicate.
-- Nullable — NULL keeps today's whole-brand behaviour byte-identical, so every
-- pre-existing CRM audience is unaffected.
ALTER TABLE audiences ADD COLUMN IF NOT EXISTS crm_upload_id text;

CREATE INDEX IF NOT EXISTS idx_audiences_crm_upload_id
  ON audiences (crm_upload_id);
