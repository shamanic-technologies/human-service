-- Audiences: record which provider's filter-set a selected audience commits to.
-- An audience produced by the onboarding `/suggest` flow is provider-specific
-- (the user compares an apollo-flavored candidate vs an apify-flavored one and
-- picks one). null = neutral/unset (legacy v1 audiences). Idempotent.
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "provider" text;
