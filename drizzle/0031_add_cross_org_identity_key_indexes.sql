-- The hard-bounce serve gate (human-service#73) resolves a free teaser's
-- pre-pay keys (apollo person id, linkedin url) to the address this gateway
-- already revealed for them, ACROSS orgs: a bounce is a fact about the address,
-- so the person is excluded for every org. The existing people indexes all lead
-- with org_id and cannot serve a key-only lookup, so without these the gate
-- seq-scans `people` and `lead_serves` on every serve. Idempotent.
CREATE INDEX IF NOT EXISTS "idx_people_apollo_person_id" ON "people" ("apollo_person_id");
CREATE INDEX IF NOT EXISTS "idx_people_apify_person_id" ON "people" ("apify_person_id");
CREATE INDEX IF NOT EXISTS "idx_people_linkedin_url_norm" ON "people" ("linkedin_url_norm");
CREATE INDEX IF NOT EXISTS "idx_lead_serves_provider_person_id" ON "lead_serves" ("provider_person_id");
