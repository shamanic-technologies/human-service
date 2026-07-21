-- Audiences learn their TRUE reachable-pool ceiling when serve-next exhausts the
-- provider pool: at that moment the count of distinct members we materialized IS
-- the reachable pool (everyone with a usable email we could serve). The provider
-- count (apollo_count) counts ALL demographic matches, not just verified-email
-- people, so it over-states the pool. The list "Remaining" clamps to
-- reachable_count - suppressed so a stale / inflated Size can never manufacture
-- phantom "remaining" contacts. NULL until the audience has been exhausted once.
ALTER TABLE audiences ADD COLUMN IF NOT EXISTS reachable_count integer;
