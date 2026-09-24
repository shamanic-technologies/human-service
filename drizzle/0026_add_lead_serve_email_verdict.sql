-- Pre-serve email verification verdict on the bronze serve log. Nullable, no
-- default: NULL is the truthful value for every serve made before verification
-- existed. Idempotent.
ALTER TABLE "lead_serves" ADD COLUMN IF NOT EXISTS "email_verdict" text;
