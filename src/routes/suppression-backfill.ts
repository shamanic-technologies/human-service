// Internal (service-auth) one-time suppression backfill.
//
// Per-brand suppression went live on 2026-06-15 and was never backfilled, so
// every person emailed before that date is invisible to the dedup: the gateway
// re-serves them and the brand re-pays a provider to re-reveal an email it
// already owns and already used recently. These two routes create the missing
// suppression rows (and take them back out), dating each one from the moment
// the person was ACTUALLY emailed so they stay suppressed for exactly the
// remainder of their own three-month window. The window itself is untouched.
//
// Deliberately NOT a sweep and NOT a detector: the exact set arrives in the
// body, because "was this person actually EMAILED?" is knowable only by the
// service that submitted to the vendor. Backfilling bare serves would re-break
// what /internal/recover-suppressions exists to repair. Engine + rationale live
// in src/services/suppression-backfill.ts.
//
// This router mounts BEFORE the global 100 KB `express.json()` and carries its
// OWN 25 MB parser (same pattern as the internal audience resolver): the repair
// set is tens of thousands of entries, far past any browser cap.
import express, { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import {
  BackfillSentSuppressionsQuerySchema,
  BackfillSentSuppressionsRequestSchema,
  RevertSentSuppressionBackfillRequestSchema,
} from "../schemas.js";
import {
  backfillSentSuppressions,
  revertSentSuppressionBackfill,
} from "../services/suppression-backfill.js";

const router = Router();

// ~25 MB covers several hundred thousand entries at ~90 bytes each — well past
// the fleet-wide repair set, while org-scoped routes keep the 100 KB guard.
const BACKFILL_BODY_LIMIT = "25mb";

router.post(
  "/internal/backfill-sent-suppressions",
  express.json({ limit: BACKFILL_BODY_LIMIT }),
  requireApiKey,
  async (req, res) => {
    const parsedQuery = BackfillSentSuppressionsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.message });
      return;
    }
    const parsed = BackfillSentSuppressionsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const result = await backfillSentSuppressions(
      parsed.data.reason,
      parsed.data.entries,
      { dryRun: parsedQuery.data.dryRun === "true" }
    );
    res.json(result);
  }
);

router.post(
  "/internal/backfill-sent-suppressions/revert",
  express.json({ limit: BACKFILL_BODY_LIMIT }),
  requireApiKey,
  async (req, res) => {
    const parsedQuery = BackfillSentSuppressionsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.message });
      return;
    }
    const parsed = RevertSentSuppressionBackfillRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const result = await revertSentSuppressionBackfill(parsed.data.reason, {
      dryRun: parsedQuery.data.dryRun === "true",
    });
    res.json(result);
  }
);

export default router;
