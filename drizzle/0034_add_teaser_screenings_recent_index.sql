-- serve-next reads an audience's most recent screen verdicts (the screen-yield
-- stop, src/services/teaser-screening.ts `readScreenYield`) once per call and
-- every 100 screens. The only index on this table leads with
-- (audience_id, provider_person_id), so that read sorted every verdict the
-- audience ever had (seq scan, ~90ms at 67k rows, growing ~13k/day).
CREATE INDEX IF NOT EXISTS "idx_audience_teaser_screenings_recent" ON "audience_teaser_screenings" ("audience_id", "created_at" DESC);
