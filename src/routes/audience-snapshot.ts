// Staff snapshot of what a brand holds in its audiences (people, companies, and
// which target audiences accepted them). Service-auth; the api-service gateway
// staff-gates it. Engine + semantics: src/services/audience-snapshot.ts.
import { Router, type Request, type Response } from "express";
import { requireApiKey } from "../middleware/auth.js";
import {
  BrandMembershipsQuerySchema,
  BrandSnapshotPageQuerySchema,
  BrandSnapshotParamsSchema,
  BrandSnapshotQuerySchema,
} from "../schemas.js";
import {
  brandAudienceSnapshot,
  brandHeldCompanies,
  brandHeldPeople,
  brandHeldPersonCompanies,
} from "../services/audience-snapshot.js";
import { brandAudienceOverlap, brandMemberships } from "../services/audience-memberships.js";

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

// One read of every held person's company (features-service sourcing figures).
router.get("/internal/brands/:brandId/audience-snapshot/person-companies", requireApiKey, async (req, res) => {
  const params = BrandSnapshotParamsSchema.safeParse(req.params);
  const query = BrandSnapshotQuerySchema.safeParse(req.query);
  if (!params.success) return badRequest(res, params.error.issues[0]?.message);
  if (!query.success) return badRequest(res, query.error.issues[0]?.message);
  res.json(await brandHeldPersonCompanies({ brandId: params.data.brandId, orgId: query.data.orgId }));
});

router.get("/internal/brands/:brandId/audience-snapshot/companies", requireApiKey, async (req, res) => {
  const args = pageArgs(req, res);
  if (!args) return;
  res.json(await brandHeldCompanies(args.scope, args.page));
});

// Multi-source provenance reads (src/services/audience-memberships.ts): RAW
// membership, every audience of the brand, any status.
const DEFAULT_MEMBERSHIPS_LIMIT = 1000;

router.get("/internal/brands/:brandId/memberships", requireApiKey, async (req, res) => {
  const params = BrandSnapshotParamsSchema.safeParse(req.params);
  const query = BrandMembershipsQuerySchema.safeParse(req.query);
  if (!params.success) return badRequest(res, params.error.issues[0]?.message);
  if (!query.success) return badRequest(res, query.error.issues[0]?.message);
  res.json(
    await brandMemberships(
      { brandId: params.data.brandId, orgId: query.data.orgId },
      { limit: query.data.limit ?? DEFAULT_MEMBERSHIPS_LIMIT, offset: query.data.offset ?? 0 }
    )
  );
});

router.get("/internal/brands/:brandId/audience-overlap", requireApiKey, async (req, res) => {
  const params = BrandSnapshotParamsSchema.safeParse(req.params);
  const query = BrandSnapshotQuerySchema.safeParse(req.query);
  if (!params.success) return badRequest(res, params.error.issues[0]?.message);
  if (!query.success) return badRequest(res, query.error.issues[0]?.message);
  res.json(await brandAudienceOverlap({ brandId: params.data.brandId, orgId: query.data.orgId }));
});

export default router;
