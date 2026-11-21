-- OUTREACH-3WAYS-1121 v2 (src/services/relation-fit.ts): the judgment is a Jev `choice`
-- (industry peers: brand_industry | other_market | unknown; investors: investor | not_investor | unknown).
-- `choice` = the answer; `yes_probability` holds its confidence from v2 on (v1 rows: P(yes), choice NULL).
ALTER TABLE "relation_fit_judgments" ADD COLUMN IF NOT EXISTS "choice" text;
