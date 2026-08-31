-- Carry apollo-service's `degraded` verdict onto the audience row.
--
-- apollo-service builds an audience's Apollo filter set through an iterative
-- refine loop that grades each candidate against the described target. When no
-- candidate is judged a good fit it no longer fails: it returns the best attempt
-- anyway, flagged `degraded: true`, so onboarding shows the customer something
-- they can judge and reject rather than an error screen (apollo-service#228).
--
-- That verdict has to survive the request that created the audience: a dashboard
-- reading the row later must see the same truth as at creation time, otherwise a
-- build the grader disowned on both axes is indistinguishable from a good one.
--
-- NOT NULL DEFAULT false: false is the truthful value for every row created
-- before the concept existed — none of them carries a degraded verdict, and we
-- never invent one. The flag is INFORMATION for the customer and the dashboard,
-- never a gate: nothing filters, blocks or warns on it.
ALTER TABLE audiences
  ADD COLUMN IF NOT EXISTS degraded boolean NOT NULL DEFAULT false;
