-- ONE PERSON, SEVERAL ADDRESSES (owner 2026-10-09): a human often writes from
-- more than one mailbox (a work address and a personal / second-company one).
-- `people.email_norm` stays the person's PRIMARY address, unchanged; every
-- address the person holds (the primary included) is a row here, so asking about
-- ANY of them resolves to the same person id.
--   source 'served'   = learned from a serve / reveal (the gateway saw it)
--   source 'attached' = an explicit act by a service or staff (never a guess)
-- An address belongs to at most ONE person per org (unique (org_id, email_norm)).
CREATE TABLE IF NOT EXISTS "person_emails" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE CASCADE,
  "email_norm" text NOT NULL,
  "company_domain" text,
  "company_name" text,
  "source" text NOT NULL,
  "evidence" text,
  "attached_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_person_emails_org_email" ON "person_emails" ("org_id", "email_norm");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_person_emails_person" ON "person_emails" ("person_id");
--> statement-breakpoint
-- Every existing primary address becomes the person's first row. Idempotent.
INSERT INTO "person_emails" ("org_id", "person_id", "email_norm", "company_domain", "company_name", "source", "created_at")
SELECT p.org_id, p.id, p.email_norm, p.company_domain, p.company_name, 'served', p.first_seen_at
FROM "people" p
WHERE p.email_norm IS NOT NULL
ON CONFLICT ("org_id", "email_norm") DO NOTHING;
