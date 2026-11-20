-- MON-PAGE-SPEED-FLOOR-1120: the brand audience snapshot reads (totals, people
-- page, companies page) keep their last computed answer here, so a dashboard
-- reload is served from one primary-key read while a fresh answer is computed
-- behind it. A copy of a read, never a source: deleting every row only makes the
-- next read compute again.
CREATE TABLE IF NOT EXISTS audience_snapshot_cache (
  cache_key text PRIMARY KEY,
  brand_id uuid NOT NULL,
  org_id uuid,
  body text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audience_snapshot_cache_brand ON audience_snapshot_cache (brand_id);
