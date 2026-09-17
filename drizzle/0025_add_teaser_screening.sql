-- Teaser screening: judge an apollo free teaser against the audience's own
-- description BEFORE paying to reveal its email.
--
-- serve-next pops a FREE teaser and immediately pays an apollo credit to enrich
-- it. Apollo's filter vocabulary cannot express every constraint an audience
-- states in plain English ("chiropractors who OWN their practice", "German-
-- speaking Switzerland"), so a teaser can match the filters and still be off
-- target — and we find out only after the credit, the email generation and the
-- send are spent. This adds a cheap LLM verdict at that exact frontier.
--
-- Layering mirrors lead_serves -> brand_suppressions, one grain over:
--   bronze audience_teaser_screenings — append-only, EVERY verdict (pass and
--     reject) with the snapshot it was judged on, the model and the prompt
--     version. A re-screen under a new prompt appends; it never overwrites.
--   silver audience_screened_out — the exclusion set the serve path reads,
--     canonical per (audience, provider person), promoted in the same txn.
--
-- Keyed on the AUDIENCE, not the brand: relevance is relative to the audience
-- that defined it, so a person rejected for one audience may be exactly right
-- for another. Brand-wide no-repeat stays brand_suppressions' job, unchanged.

-- The judgeable snapshot, persisted at BUFFER time because that is where the
-- Person object is in hand — the pop path holds only an enrich handle. NULL on
-- rows buffered before this migration: nothing to judge, so those are served
-- unscreened (counted + logged, never silently).
ALTER TABLE "audience_teaser_buffer" ADD COLUMN IF NOT EXISTS "teaser" jsonb;

CREATE TABLE IF NOT EXISTS "audience_teaser_screenings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "provider_person_id" text NOT NULL,
  "linkedin_url" text,
  "teaser" jsonb NOT NULL,
  "verdict" boolean NOT NULL,
  "reason" text,
  "model" text NOT NULL,
  "prompt_version" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_audience_teaser_screenings_lookup"
  ON "audience_teaser_screenings" ("audience_id", "provider_person_id");

CREATE TABLE IF NOT EXISTS "audience_screened_out" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "provider_person_id" text NOT NULL,
  "linkedin_url" text,
  "reason" text,
  "screened_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_screened_out_unique"
  ON "audience_screened_out" ("audience_id", "provider_person_id");
