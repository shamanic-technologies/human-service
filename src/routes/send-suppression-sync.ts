import { messageOf } from "../lib/db-error.js";
import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { SendFeedConfigError, SendFeedSourceError } from "../lib/instantly-sends.js";
import { runSendSuppressionSync } from "../services/send-suppression-sync.js";

const router = Router();

// POST /internal/sync-send-suppressions
//
// Run the send → suppression sync now instead of waiting for its tick (see
// src/services/send-suppression-sync.ts): copy every real email instantly-service
// sent since the stored cursor onto the brand's suppression window. Idempotent.
router.post("/internal/sync-send-suppressions", requireApiKey, async (_req, res) => {
  try {
    const result = await runSendSuppressionSync();
    if (!result) {
      res.status(409).json({ error: "A sync is already running, or migrations are not ready." });
      return;
    }
    res.json(result);
  } catch (err) {
    if (err instanceof SendFeedConfigError || err instanceof SendFeedSourceError) {
      res.status(502).json({ error: messageOf(err), source: "instantly-service" });
      return;
    }
    throw err;
  }
});

export default router;
