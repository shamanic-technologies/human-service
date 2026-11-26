-- AUDIENCE-SOURCE-BY-FIT-1126 (src/services/audience-fit.ts): does a company / person a provider handed us
-- belong to the audience's target text? ONE Jev judgment per (audience, provider, subject, prompt version),
-- judged once and persisted (bronze): the provider measurement (which provider finds the most fitting companies
-- per dollar) and the companies preview (only fitting companies + persons are shown) both read it.
-- No org_id: the org is the audience's (cascades with it, follows it through a brand transfer).
CREATE TABLE IF NOT EXISTS "audience_fit_judgments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "subject_key" text NOT NULL,
  "prompt_version" text NOT NULL,
  "target_text" text NOT NULL,
  "subject" jsonb NOT NULL,
  "company_fit" text NOT NULL,
  "company_confidence" double precision NOT NULL,
  "person_fit" text NOT NULL,
  "person_confidence" double precision NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_fit_judgments_subject"
  ON "audience_fit_judgments" ("audience_id", "provider", "subject_key", "prompt_version");
