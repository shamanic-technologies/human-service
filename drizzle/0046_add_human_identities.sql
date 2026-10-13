-- ONE HUMAN ACROSS THE FLEET (LEAD-REFONTE-1013, owner 2026-10-13).
-- `people` stays ONE person per client org (audiences, serves, suppression
-- unchanged). A `human_identities` row is the real human behind them, shared by
-- every org and every service: one id per human, whichever client bought them and
-- whichever tool saw them. A person hangs off a human through `people.human_id`.
--
-- A human row is ATOMIC: it is never rewritten or deleted. Two humans become one
-- through a `human_links` statement, and the human an org sees is the connected
-- component of the links visible to it (fleet links + that org's links), named by
-- its OLDEST member. A merge or a split is therefore a row, never a data move, so
-- every one is recorded with who/why and is withdrawable.
CREATE TABLE IF NOT EXISTS "human_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_by" text NOT NULL,
  -- clock_timestamp, not now(): several humans minted in one transaction must
  -- still have an order, since the oldest names the merged human.
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
-- The keys that resolve a human. Fleet-wide and unique: an address / number /
-- profile / provider id belongs to ONE atomic human. kind: email | phone |
-- linkedin_url | apollo_person_id | apify_person_id. Only email and phone are
-- PROOF (a shared one merges two humans automatically, fleet-wide); the others
-- only resolve.
CREATE TABLE IF NOT EXISTS "human_identity_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "human_id" uuid NOT NULL REFERENCES "human_identities"("id"),
  "kind" text NOT NULL,
  "value_norm" text NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_human_identity_keys_kind_value" ON "human_identity_keys" ("kind", "value_norm");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_human_identity_keys_human" ON "human_identity_keys" ("human_id");
--> statement-breakpoint
-- Merge / split statements between two atomic humans (stored a < b).
--   relation 'same'     = merge;  'distinct' = split (cuts a 'same' between the
--                         pair in its scope and blocks an automatic re-merge).
--   scope 'fleet'       = every org sees it; only PROOF ('shared_email' /
--                         'shared_phone') makes a fleet 'same'.
--   scope 'org'         = only org_id sees it (a judgment: a person or Jev).
-- Withdrawn rows stay (history); withdrawing is the undo.
CREATE TABLE IF NOT EXISTS "human_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "relation" text NOT NULL,
  "scope" text NOT NULL,
  "org_id" uuid,
  "a_human_id" uuid NOT NULL REFERENCES "human_identities"("id"),
  "b_human_id" uuid NOT NULL REFERENCES "human_identities"("id"),
  "basis" text NOT NULL,
  "proof_kind" text,
  "proof_value_norm" text,
  "judged_by" text NOT NULL,
  "stated_by" text NOT NULL,
  "evidence" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "withdrawn_at" timestamp with time zone,
  "withdrawn_by" text,
  "withdraw_reason" text,
  CONSTRAINT "human_links_ordered" CHECK ("a_human_id" < "b_human_id"),
  CONSTRAINT "human_links_scope_org" CHECK (("scope" = 'fleet' AND "org_id" IS NULL) OR ("scope" = 'org' AND "org_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_human_links_a" ON "human_links" ("a_human_id") WHERE "withdrawn_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_human_links_b" ON "human_links" ("b_human_id") WHERE "withdrawn_at" IS NULL;
--> statement-breakpoint
-- Facts about the human wherever they work (owner: "carried on the human").
-- kind: opt_out | do_not_contact. Who heard it (org) and through which service is
-- recorded; reading what it means is the consumer's job.
CREATE TABLE IF NOT EXISTS "human_facts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "human_id" uuid NOT NULL REFERENCES "human_identities"("id"),
  "kind" text NOT NULL,
  "stated_by_org_id" uuid,
  "source" text NOT NULL,
  "evidence" text NOT NULL,
  "stated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "withdrawn_at" timestamp with time zone,
  "withdrawn_by" text,
  "withdraw_reason" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_human_facts_human" ON "human_facts" ("human_id");
--> statement-breakpoint
-- Append-only feed consumers follow by cursor (bigserial id). org_id NULL = a
-- fleet event every org sees; set = only that org's.
CREATE TABLE IF NOT EXISTS "human_identity_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "org_id" uuid,
  "human_ids" uuid[] NOT NULL,
  "data" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_human_identity_events_org" ON "human_identity_events" ("org_id", "id");
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "human_id" uuid REFERENCES "human_identities"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_people_human" ON "people" ("human_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_people_unlinked" ON "people" ("id") WHERE "human_id" IS NULL;
