-- Per-audience one-sentence description, distinct from the shared batch nlPrompt.
-- Populated from the layer-1 segment description at /suggest time. Nullable —
-- existing rows stay null (the dashboard hides "Described as" when null and
-- NEVER falls back to the multi-audience nlPrompt).
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "description" text;
