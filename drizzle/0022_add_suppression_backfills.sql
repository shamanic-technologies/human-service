-- Reversible ledger for one-time suppression backfills.
--
-- Per-brand suppression went live on 2026-06-15 and has held since, but it was
-- never backfilled: everyone contacted before that date is invisible to the
-- dedup, so the fleet re-serves — and re-pays for — people it already emailed.
-- Backfilling such a person means INSERTING their silver `brand_suppressions`
-- row with `last_served_at` set to the moment they were ACTUALLY EMAILED, so
-- they stay suppressed for exactly the remainder of their three-month window,
-- as if the guard had been live at the time. The window itself is untouched.
--
-- This table records every row the repair CREATED, tagged with the `reason`,
-- which makes it:
--   identifiable — SELECT ... WHERE reason = '<tag>'
--   reversible   — the revert deletes exactly those suppression rows
--   idempotent   — unique (reason, org, brand, email_norm) ⟹ a re-run writes
--                  nothing new and says so
--
-- `sent_at` is stored so the revert can tell a backfilled row that has since
-- been re-served (last_served_at moved) from one that has not: the newer serve
-- wins and its row is never deleted.
--
-- Bronze `lead_serves` is deliberately untouched — it is the append-only audit
-- of what the GATEWAY emitted, and a send it never made is not its to record.

CREATE TABLE IF NOT EXISTS "suppression_backfills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reason" text NOT NULL,
  "suppression_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "email_norm" text NOT NULL,
  "sent_at" timestamp with time zone NOT NULL,
  "backfilled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_suppression_backfills_unique" ON "suppression_backfills" ("reason", "org_id", "brand_id", "email_norm");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_suppression_backfills_reason" ON "suppression_backfills" ("reason");
