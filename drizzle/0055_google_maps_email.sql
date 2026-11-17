-- GMAPS-EMAIL-1117: the Google Maps source also serves EMAIL leads.
--
-- google_maps_site_reads (bronze): what a business's own website published,
-- read once per Google place id, fleet-wide (a public page is the same fact for
-- every org): the pages read through treg (url, answer, charge, text), every
-- address found on them, the address chosen for the business and the person the
-- site names (never invented: the name is a substring of the pages read).
CREATE TABLE IF NOT EXISTS google_maps_site_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id text NOT NULL,
  website text,
  org_id uuid NOT NULL,
  run_id text,
  -- found | no_website | no_email
  outcome text NOT NULL,
  pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  emails text[] NOT NULL DEFAULT '{}',
  email text,
  contact_name text,
  contact_role text,
  charged_micro integer NOT NULL DEFAULT 0,
  read_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_maps_site_reads_place ON google_maps_site_reads (place_id);

-- Per business of an audience: its email channel (null = not read yet).
ALTER TABLE google_maps_places ADD COLUMN IF NOT EXISTS email_status text;
ALTER TABLE google_maps_places ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE google_maps_places ADD COLUMN IF NOT EXISTS email_verdict text;

-- A business without a phone is no longer decided for good: an email pipe may
-- still serve it. The walk filters on the channel it needs instead.
UPDATE google_maps_places SET status = 'waiting' WHERE status = 'no_phone';
