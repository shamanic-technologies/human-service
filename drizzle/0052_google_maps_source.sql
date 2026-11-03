-- GMAPS-SOURCE-1103: a Google Maps lead source (src/services/google-maps-source.ts).
-- An audience with provider 'google_maps' finds local businesses on Google Maps
-- (through treg) from the search queries its target expands to, and serves each
-- business as a lead with a phone. Three tables:
--   google_maps_queries  : every search the audience runs, once, with its charge (bronze of the walk).
--   google_maps_places   : every business a search returned for the audience, and what became of it.
--   google_maps_brand_claims : one business (place id, and its phone) is served at most once per brand.

CREATE TABLE IF NOT EXISTS google_maps_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  audience_id uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  position integer NOT NULL,
  query text NOT NULL,
  -- NULL = not run yet. Set once the search answered (its places are stored).
  ran_at timestamptz,
  -- The run that paid for the search (our google-maps-search child run).
  run_id text,
  served_by text,
  charged_micro integer,
  places_count integer,
  new_places_count integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_maps_queries_unique ON google_maps_queries (audience_id, query);
CREATE INDEX IF NOT EXISTS idx_google_maps_queries_next ON google_maps_queries (audience_id, position) WHERE ran_at IS NULL;

CREATE TABLE IF NOT EXISTS google_maps_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  audience_id uuid NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  place_id text NOT NULL,
  query_id uuid,
  -- Google's order within the search that found it (served in that order).
  rank integer NOT NULL DEFAULT 0,
  -- The place as the provider served it (verbatim row).
  place jsonb NOT NULL,
  phone_e164 text,
  -- waiting | checking | served | taken | no_phone | not_on_whatsapp | own_company
  status text NOT NULL DEFAULT 'waiting',
  found_run_id text,
  served_run_id text,
  person_id uuid,
  found_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_maps_places_unique ON google_maps_places (audience_id, place_id);
CREATE INDEX IF NOT EXISTS idx_google_maps_places_drain ON google_maps_places (audience_id, status, found_at, rank);

CREATE TABLE IF NOT EXISTS google_maps_brand_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  place_id text NOT NULL,
  phone_e164 text,
  audience_id uuid,
  person_id uuid,
  run_id text,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_maps_brand_claims_place ON google_maps_brand_claims (org_id, brand_id, place_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_maps_brand_claims_phone ON google_maps_brand_claims (org_id, brand_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_google_maps_brand_claims_org_place ON google_maps_brand_claims (org_id, place_id);
