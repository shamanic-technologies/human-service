// Internal (service-auth) bulk audience resolver for lead-service (#166 /
// sales-lead-service#346). Server-to-server, no browser body cap: lead-service
// fans out a whole brand's leads (thousands of emails) in ONE call to attach the
// audience card onto each lead server-side — impossible against the org+email
// /orgs/audiences/stats route (100 KB gateway cap -> 413).
//
// This router mounts BEFORE the global 100 KB `express.json()` and carries its
// OWN 25 MB parser, so the large payload is accepted here and skipped by the
// global parser (body-parser sets req._body and later parsers no-op). The
// resolution engine + rationale live in src/services/audiences.ts.
import express, { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { ResolveAudiencesRequestSchema } from "../schemas.js";
import { resolveAudiencesForBrand } from "../services/audiences.js";

const router = Router();

// ~25 MB covers ~500k emails at ~50 bytes each — far beyond any single brand's
// lead count, while the org-scoped routes keep the 100 KB browser guard.
const RESOLVE_BODY_LIMIT = "25mb";

router.post(
  "/internal/audiences/resolve",
  express.json({ limit: RESOLVE_BODY_LIMIT }),
  requireApiKey,
  async (req, res) => {
    const parsed = ResolveAudiencesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }
    const { orgId, brandId, audienceIds, emails } = parsed.data;
    const result = await resolveAudiencesForBrand(orgId, brandId, {
      audienceIds,
      emails,
    });
    res.json(result);
  }
);

export default router;
