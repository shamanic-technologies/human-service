// BLANK-CANDIDATES-1101: re-offer the candidates declined while blank (no facts about the person), with the person's
// stored teaser, and undo it. Engine + rationale: src/services/blank-candidate-rejudge.ts.
import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { RejudgeBlankCandidatesQuerySchema, RejudgeBlankCandidatesRequestSchema } from "../schemas.js";
import { rejudgeBlankCandidates, revertRejudge } from "../services/blank-candidate-rejudge.js";

const router = Router();

function parse(req: { query: unknown; body: unknown }) {
  const q = RejudgeBlankCandidatesQuerySchema.safeParse(req.query);
  if (!q.success) return { error: q.error.message } as const;
  const b = RejudgeBlankCandidatesRequestSchema.safeParse(req.body);
  if (!b.success) return { error: b.error.issues[0]?.message ?? "Invalid request" } as const;
  return { reason: b.data.reason, dryRun: q.data.dryRun === "true" } as const;
}

router.post("/internal/rejudge-blank-candidates", requireApiKey, async (req, res) => {
  const p = parse(req);
  if ("error" in p) return void res.status(400).json({ error: p.error });
  res.json(await rejudgeBlankCandidates(p.reason, { dryRun: p.dryRun }));
});

router.post("/internal/rejudge-blank-candidates/revert", requireApiKey, async (req, res) => {
  const p = parse(req);
  if ("error" in p) return void res.status(400).json({ error: p.error });
  res.json(await revertRejudge(p.reason, { dryRun: p.dryRun }));
});

export default router;
