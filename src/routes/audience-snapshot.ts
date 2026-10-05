// Staff snapshot of what a brand holds in its audiences (people, companies, and
// which target audiences accepted them). Service-auth; the api-service gateway
// staff-gates it. Engine + semantics: src/services/audience-snapshot.ts.
import { Router, type Request, type Response } from "express";
import { requireApiKey } from "../middleware/auth.js";
import {
  BrandSnapshotPageQuerySchema,
  BrandSnapshotParamsSchema,
  BrandSnapshotQuerySchema,
} from "../schemas.js";
import {
  brandAudienceSnapshot,
  brandHeldCompanies,
  brandHeldPeople,
} from "../services/audience-snapshot.js";

const router = Router();

const DEFAULT_LIMIT = 50;

function badRequest(res: Response, message: string | undefined) {
  res.status(400).json({ error: message ?? "Invalid request" });
}

router.get("/internal/brands/:brandId/audience-snapshot", requireApiKey, async (req, res) => {
  const params = BrandSnapshotParamsSchema.safeParse(req.params);
  const query = BrandSnapshotQuerySchema.safeParse(req.query);
  if (!params.success) return badRequest(res, params.error.issues[0]?.message);
  if (!query.success) return badRequest(res, query.error.issues[0]?.message);
  res.json(await brandAudienceSnapshot({ brandId: params.data.brandId, orgId: query.data.orgId }));
});

function pageArgs(req: Request, res: Response) {
  const params = BrandSnapshotParamsSchema.safeParse(req.params);
  const query = BrandSnapshotPageQuerySchema.safeParse(req.query);
  if (!params.success) return badRequest(res, params.error.issues[0]?.message);
  if (!query.success) return badRequest(res, query.error.issues[0]?.message);
  return {
    scope: { brandId: params.data.brandId, orgId: query.data.orgId },
    page: {
      limit: query.data.limit ?? DEFAULT_LIMIT,
      offset: query.data.offset ?? 0,
      acceptedOnly: query.data.acceptedOnly === "true",
    },
  };
}

router.get("/internal/brands/:brandId/audience-snapshot/people", requireApiKey, async (req, res) => {
  const args = pageArgs(req, res);
  if (!args) return;
  res.json(await brandHeldPeople(args.scope, args.page));
});

router.get("/internal/brands/:brandId/audience-snapshot/companies", requireApiKey, async (req, res) => {
  const args = pageArgs(req, res);
  if (!args) return;
  res.json(await brandHeldCompanies(args.scope, args.page));
});

export default router;
