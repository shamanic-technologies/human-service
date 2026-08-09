// Internal (service-auth) one-time suppression recovery.
//
// Serving a person records a suppression, which is right — the gateway did emit
// them. When the downstream send never reaches the vendor, that person stays
// permanently un-emittable for the brand while nothing was ever sent to them.
// These two routes archive + delete those suppression rows (and put them back),
// so the brand gets its unreached prospects back into its addressable universe.
//
// Deliberately NOT a sweep and NOT a detector: the exact set arrives in the body,
// because "was this person actually handed to the vendor?" is knowable only by
// the service that submitted to the vendor. Engine + rationale live in
// src/services/suppression-recovery.ts.
import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import {
  RecoverSuppressionsQuerySchema,
  RecoverSuppressionsRequestSchema,
  RevertSuppressionRecoveryRequestSchema,
} from "../schemas.js";
import {
  recoverSuppressions,
  revertSuppressionRecovery,
} from "../services/suppression-recovery.js";

const router = Router();

router.post("/internal/recover-suppressions", requireApiKey, async (req, res) => {
  const parsedQuery = RecoverSuppressionsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }
  const parsed = RecoverSuppressionsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "Invalid request",
    });
    return;
  }

  const result = await recoverSuppressions(
    parsed.data.reason,
    parsed.data.entries,
    { dryRun: parsedQuery.data.dryRun === "true" }
  );
  res.json(result);
});

router.post(
  "/internal/recover-suppressions/revert",
  requireApiKey,
  async (req, res) => {
    const parsedQuery = RecoverSuppressionsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.message });
      return;
    }
    const parsed = RevertSuppressionRecoveryRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    const result = await revertSuppressionRecovery(parsed.data.reason, {
      dryRun: parsedQuery.data.dryRun === "true",
    });
    res.json(result);
  }
);

export default router;
