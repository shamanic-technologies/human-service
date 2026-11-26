-- GMAPS-SITE-READ-EMPTY-1126: treg.web.extract returns each provider's OWN row, and the site reader read only
-- tinyfish's `text`. Every page served by crawl4ai (`markdown`), parallel (`excerpts`), search1api (`content`)...
-- read as empty, and the business was stored "no email" for good (1,445 shops on 2026-11-26 alone, charged).
-- Repair, from stored facts only: a site read stored `no_email` whose pages ALL carry no text was a failed read,
-- never "this site publishes no email". It is archived verbatim in google_maps_live_repairs and deleted (the
-- reader no longer stores such a read), and every business still WAITING with that outcome waits again with no
-- email status, so the next walk reads its site again. Reversible from the archive; idempotent.
WITH empty AS (
  SELECT r.* FROM google_maps_site_reads r
  WHERE r.outcome = 'no_email'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(r.pages) pg WHERE coalesce(pg->>'text', '') <> ''
    )
), arch_r AS (
  INSERT INTO google_maps_live_repairs (reason, kind, row_data)
  SELECT 'gmaps-site-read-empty-1126', 'empty_site_read', to_jsonb(e) FROM empty e RETURNING 1
), places AS (
  SELECT p.* FROM google_maps_places p JOIN empty e ON e.place_id = p.place_id
  WHERE p.status = 'waiting' AND p.email_status = 'no_email'
), arch_p AS (
  INSERT INTO google_maps_live_repairs (reason, kind, row_data)
  SELECT 'gmaps-site-read-empty-1126', 'no_email_place', to_jsonb(p) FROM places p RETURNING 1
), reset AS (
  UPDATE google_maps_places p SET email_status = NULL, email = NULL, email_verdict = NULL
  FROM places x WHERE p.id = x.id RETURNING 1
)
DELETE FROM google_maps_site_reads r USING empty e WHERE r.place_id = e.place_id;
