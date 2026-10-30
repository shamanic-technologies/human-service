import { Router } from "express";
import { and, asc, gt, sql } from "drizzle-orm";
import { requireApiKey } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { candidateWalks } from "../db/schema.js";
import { walkDecideDoor, walkPageDoor } from "../services/audience-candidates.js";

const router = Router();

/**
 * POST /internal/candidate-walks/page {walk, limit} and /decide {walk, verdicts} (FACTORY-P3 next outcomes,
 * lead_found): the stored walk script's doors. Serve ONLY a walk in flight here (`walk` = the token this service
 * handed the script as material). `page` = up to `limit` teasers with the facts each free rule reads, or how the walk
 * ends (pending / exhausted); `decide` = the page's verdicts in its order, applied as our own walk applies them.
 * 409 = no such walk in flight; 502 = refused (re-thrown to the serve as our own error).
 */
router.post("/internal/candidate-walks/:door", requireApiKey, async (req, res) => {
  const walk = typeof req.body?.walk === "string" ? req.body.walk : "";
  if (!walk) return res.status(400).json({ error: "walk (the token of a walk in flight) is required" });
  try {
    if (req.params.door === "page") {
      const limit = Number(req.body?.limit);
      if (!Number.isInteger(limit) || limit < 1) return res.status(400).json({ error: "limit must be a positive integer" });
      const out = await walkPageDoor(walk, limit);
      return res.status(out.status).json(out.body);
    }
    if (req.params.door === "decide") {
      const verdicts = Array.isArray(req.body?.verdicts) ? (req.body.verdicts as Array<{ ref: string; verdict: string }>) : null;
      if (!verdicts) return res.status(400).json({ error: "verdicts is required" });
      const out = await walkDecideDoor(walk, verdicts);
      return res.status(out.status).json(out.body);
    }
    return res.status(404).json({ error: `no door ${req.params.door}` });
  } catch (error) {
    console.error(`[human-service] candidate walk door ${req.params.door} failed:`, error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** GET /internal/candidate-walks/recorded?after=<seq>&limit= — every recorded walk, oldest first (60 s settle). */
router.get("/internal/candidate-walks/recorded", requireApiKey, async (req, res) => {
  const after = req.query.after === undefined ? 0 : Number(req.query.after);
  const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return res.status(400).json({ error: "after (a seq >= 0) and limit (1..1000) must be integers" });
  }
  try {
    const rows = await db
      .select()
      .from(candidateWalks)
      .where(and(gt(candidateWalks.seq, after), sql`${candidateWalks.createdAt} < now() - interval '60 seconds'`))
      .orderBy(asc(candidateWalks.seq))
      .limit(limit);
    return res.json({ decisions: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), nextAfter: rows.length > 0 ? rows[rows.length - 1]!.seq : after, hasMore: rows.length === limit });
  } catch (error) {
    console.error("[human-service] candidate walks read failed:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
