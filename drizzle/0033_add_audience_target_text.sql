-- ONE text per audience: who the customer wants for THIS audience. It is what
-- the dashboard shows as "the audience" and what the pre-pay screen judges every
-- candidate against. `nl_prompt` stays (it is the SHARED target of every
-- audience a split produced, so it cannot tell siblings apart); `target_text`
-- is the per-audience text.
--
-- target_text_origin: 'segment_target' (drafted for this audience from the
-- shared target + its own segment sentence) | 'audience_target' (the audience
-- is not one of several: its nl_prompt IS its text). NULL with target_text NULL
-- = not written yet (backfill pending) or no customer text exists at all.
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "target_text" text;
ALTER TABLE "audiences" ADD COLUMN IF NOT EXISTS "target_text_origin" text;

-- Screening evidence: the exact text each verdict was judged against, and which
-- field it came from ('target_text' | 'nl_prompt'). NULL on rows judged before
-- this column existed (they were judged against nl_prompt).
ALTER TABLE "audience_teaser_screenings" ADD COLUMN IF NOT EXISTS "target_text" text;
ALTER TABLE "audience_teaser_screenings" ADD COLUMN IF NOT EXISTS "target_field" text;
