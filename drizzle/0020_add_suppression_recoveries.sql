-- Reversible ledger for one-time suppression recoveries.
--
-- A serve that was recorded in `brand_suppressions` but whose downstream send
-- never reached the vendor leaves a person permanently un-emittable for that
-- brand even though nothing was ever sent to them. Recovering such a person
-- means DELETING their silver suppression row (the only read surface the serve
-- paths consult) — so this table archives the row, verbatim, before it goes,
-- tagged with the incident `reason`, which makes the repair identifiable and
-- undoable.
--
-- One row per recovered (reason, org, brand, email_norm): the unique index is
-- what makes a re-run idempotent (already-recovered entries are counted, not
-- re-applied). A revert restores the archived row into `brand_suppressions`
-- verbatim and deletes the ledger row, returning the DB to its pre-repair state.
--
-- Bronze `lead_serves` is deliberately untouched: it is the append-only audit of
-- what the gateway actually emitted, and it stays true. A future silver rebuild
-- from bronze must consult this ledger.

CREATE TABLE IF NOT EXISTS "suppression_recoveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reason" text NOT NULL,
  "suppression_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "email_norm" text NOT NULL,
  "linkedin_url_norm" text,
  "provider_person_id" text,
  "last_provider" text,
  "first_served_at" timestamp with time zone NOT NULL,
  "last_served_at" timestamp with time zone NOT NULL,
  "recovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_suppression_recoveries_unique" ON "suppression_recoveries" ("reason", "org_id", "brand_id", "email_norm");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_suppression_recoveries_reason" ON "suppression_recoveries" ("reason");
