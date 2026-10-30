import { Router } from "express";
import { and, asc, gt, sql } from "drizzle-orm";
import { requireApiKey } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { audienceSplitProposals } from "../db/schema.js";
import { SPLIT_COMPLETE_CALL, SPLIT_JUDGE_CALL, splitDoor } from "../services/audience-split.js";

const router = Router();
const DOORS: Record<string, string> = { complete: SPLIT_COMPLETE_CALL, judge: SPLIT_JUDGE_CALL };

/**
 * POST /internal/audience-splits/{complete,judge} {proposal, ...} (FACTORY-P3 next outcomes, audience_built): the
 * stored split script's doors, our exact chat-service completion (retries included) / icon judgment for a proposal IN
 * FLIGHT here (`proposal` = the token handed as material), its spend on the script's run (`x-run-id`). 409 nothing in
 * flight; 502 refused (re-thrown to the caller as our own error).
 */
router.post("/internal/audience-splits/:door", requireApiKey, async (req, res) => {
  const call = DOORS[req.params.door];
  const token = typeof req.body?.proposal === "string" ? req.body.proposal : "";
  const scriptRunId = typeof req.headers["x-run-id"] === "string" ? req.headers["x-run-id"] : "";
  if (!call) return res.status(404).json({ error: `no door ${req.params.door}` });
  if (!token || !scriptRunId) return res.status(400).json({ error: "proposal (the token in flight) and x-run-id (the script's run) are required" });
  const { proposal: _token, ...args } = req.body as Record<string, unknown>;
  try {
    const out = await splitDoor(token, scriptRunId, call, args);
    return res.status(out.status).json(out.body);
  } catch (error) {
    console.error(`[human-service] split door ${req.params.door} failed:`, error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** GET /internal/audience-splits/recorded?after=<seq>&limit= — every recorded proposal, oldest first (60 s settle). */
router.get("/internal/audience-splits/recorded", requireApiKey, async (req, res) => {
  const after = req.query.after === undefined ? 0 : Number(req.query.after);
  const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return res.status(400).json({ error: "after (a seq >= 0) and limit (1..1000) must be integers" });
  }
  try {
    const rows = await db
      .select()
      .from(audienceSplitProposals)
      .where(and(gt(audienceSplitProposals.seq, after), sql`${audienceSplitProposals.createdAt} < now() - interval '60 seconds'`))
      .orderBy(asc(audienceSplitProposals.seq))
      .limit(limit);
    return res.json({ decisions: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), nextAfter: rows.length > 0 ? rows[rows.length - 1]!.seq : after, hasMore: rows.length === limit });
  } catch (error) {
    console.error("[human-service] split proposals read failed:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
