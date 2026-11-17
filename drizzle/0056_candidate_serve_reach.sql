-- GMAPS-TARGET-WALK-1117: an offer audience's Google Maps candidate is revealed on
-- the channels the walk that offered it asked for (reachableBy / reachableOn), so
-- the reveal decides the business the same way without the caller re-stating them.
ALTER TABLE audience_candidates ADD COLUMN IF NOT EXISTS serve_reach jsonb;
