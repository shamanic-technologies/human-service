-- GMAPS-LIVE-1117: the first live Google Maps run (2026-11-17) read every dataforseo row as a business with no
-- name and no website, and a serve stating no reach walked by phone. Repair, from stored facts only, generic:
--   1. a candidate a target DECLINED while its teaser named no business was judged blind: re-opened (candidate
--      and its `declined:` rejection removed), so the walk offers it again with its facts;
--   2. a business served through a target's candidate walked with NO stated reach and no email was claimed for
--      the brand forever with nothing to write to: the claim, the candidate and the served state are released
--      (the business waits again; bronze lead_serves and memberships stay as history);
--   3. a list paused by hand for this incident (status_set_reason 'GMAPS-LIVE-1117:%') runs again.
-- Every removed row is archived verbatim in google_maps_live_repairs (reversible).
CREATE TABLE IF NOT EXISTS google_maps_live_repairs (
  id bigserial PRIMARY KEY,
  reason text NOT NULL,
  kind text NOT NULL,
  row_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

WITH blind AS (
  SELECT c.* FROM audience_candidates c
  JOIN audiences l ON l.id = c.search_audience_id AND l.provider = 'google_maps'
  WHERE c.status = 'declined' AND c.teaser->>'organizationName' IS NULL
), arch_c AS (
  INSERT INTO google_maps_live_repairs (reason, kind, row_data)
  SELECT 'gmaps-live-1117', 'blind_candidate', to_jsonb(b) FROM blind b RETURNING 1
), arch_s AS (
  INSERT INTO google_maps_live_repairs (reason, kind, row_data)
  SELECT 'gmaps-live-1117', 'blind_rejection', to_jsonb(s) FROM audience_screened_out s
  JOIN blind b ON b.audience_id = s.audience_id AND b.provider_person_id = s.provider_person_id
  WHERE s.reason LIKE 'declined:%' RETURNING 1
), del_s AS (
  DELETE FROM audience_screened_out s USING blind b
  WHERE b.audience_id = s.audience_id AND b.provider_person_id = s.provider_person_id AND s.reason LIKE 'declined:%' RETURNING 1
)
DELETE FROM audience_candidates c USING blind b WHERE c.id = b.id;

WITH phone_only AS (
  SELECT c.id AS candidate_id, p.id AS place_row_id, l.org_id, l.brand_id, p.place_id
  FROM audience_candidates c
  JOIN audiences l ON l.id = c.search_audience_id AND l.provider = 'google_maps'
  JOIN google_maps_places p ON p.audience_id = l.id AND p.place_id = c.provider_person_id
  WHERE c.status = 'revealed' AND p.status = 'served' AND p.email IS NULL
    AND coalesce(jsonb_array_length(c.serve_reach->'reachableBy'), 0) = 0
    AND coalesce(jsonb_array_length(c.serve_reach->'reachableOn'), 0) = 0
), arch_k AS (
  INSERT INTO google_maps_live_repairs (reason, kind, row_data)
  SELECT 'gmaps-live-1117', 'phone_only_claim', to_jsonb(k) FROM google_maps_brand_claims k
  JOIN phone_only o ON o.org_id = k.org_id AND o.brand_id = k.brand_id AND o.place_id = k.place_id RETURNING 1
), arch_c AS (
  INSERT INTO google_maps_live_repairs (reason, kind, row_data)
  SELECT 'gmaps-live-1117', 'phone_only_candidate', to_jsonb(c) FROM audience_candidates c
  JOIN phone_only o ON o.candidate_id = c.id RETURNING 1
), del_k AS (
  DELETE FROM google_maps_brand_claims k USING phone_only o
  WHERE o.org_id = k.org_id AND o.brand_id = k.brand_id AND o.place_id = k.place_id RETURNING 1
), del_c AS (
  DELETE FROM audience_candidates c USING phone_only o WHERE c.id = o.candidate_id RETURNING 1
)
UPDATE google_maps_places p SET status = 'waiting', decided_at = now(), person_id = NULL, served_run_id = NULL
FROM phone_only o WHERE p.id = o.place_row_id;

UPDATE audiences SET status = 'active', status_set_by = 'system', status_set_reason = 'GMAPS-LIVE-1117 fix live', status_set_at = now(), updated_at = now()
WHERE status = 'paused' AND status_set_reason LIKE 'GMAPS-LIVE-1117:%';
