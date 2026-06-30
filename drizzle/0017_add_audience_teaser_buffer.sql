-- serve-next apollo free-teaser drain buffer.
--
-- Apollo's POST /search/next returns up to 100 FREE teasers per page AND advances
-- its server-side cursor a whole page. serve-next reveals ONE lead per call, so
-- the other ~99 teasers per page were discarded while the forward-only cursor
-- moved on for good — capping an apollo audience at ~1 served lead per page
-- (~1% of its verified-email pool). This buffer holds a fetched page's teasers so
-- serve-next drains them ONE per call and only RE-advances apollo's cursor once
-- the buffer is empty, raising the servable cap to ~100% of the pool.
--
-- Bounded (≤ one apollo page per audience in flight), self-draining (popped on
-- read via DELETE ... RETURNING with FOR UPDATE SKIP LOCKED — no cron), and
-- cascade-deleted with its audience. Idempotent DDL (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS "audience_teaser_buffer" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "audiences"("id") ON DELETE CASCADE,
  "provider_person_id" text NOT NULL,
  "linkedin_url" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audience_teaser_buffer_unique" ON "audience_teaser_buffer" ("audience_id", "provider_person_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audience_teaser_buffer_drain" ON "audience_teaser_buffer" ("org_id", "audience_id", "created_at");
