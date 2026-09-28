-- Pre-pay screen v2: Jev's probability that the teaser belongs to the audience.
-- Nullable, no default: NULL is the truthful value for every v1 row (a bare
-- boolean with no confidence). Idempotent.
ALTER TABLE "audience_teaser_screenings" ADD COLUMN IF NOT EXISTS "yes_probability" double precision;
