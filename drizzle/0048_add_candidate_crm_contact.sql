-- CRM-SERVE-FIND-EMAIL-1021: CRM contacts are offered as candidates (qualified by
-- lead-service before any paid email lookup). The handed-out crm-service contact is
-- kept on the candidate row, so the reveal and a re-offer never call crm-service again.
ALTER TABLE audience_candidates ADD COLUMN IF NOT EXISTS crm_contact jsonb;
