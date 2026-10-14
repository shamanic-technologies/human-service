// Internal (service-auth) routes of the fleet-wide human identity. The model and
// its rules live in src/services/human-identity.ts.
import { Router, type NextFunction, type Request, type Response } from "express";
import { requireApiKey } from "../middleware/auth.js";
import {
  HumanEventsQuerySchema,
  HumanFactIdParamsSchema,
  HumanIdParamsSchema,
  HumanLinkIdParamsSchema,
  HumanViewQuerySchema,
  LinkPeopleQuerySchema,
  ResolveHumanRequestSchema,
  StateHumanFactRequestSchema,
  StateHumanLinkRequestSchema,
  WithdrawHumanFactRequestSchema,
  WithdrawHumanLinkRequestSchema,
} from "../schemas.js";
import {
  FactNotFoundError,
  FleetMergeNeedsProofError,
  HumanNotFoundError,
  InvalidIdentityKeyError,
  LinkNotFoundError,
  SeparatedHumansError,
  StillOneHumanError,
  getHumanView,
  listEvents,
  messagingHandleKey,
  normalizeKey,
  resolveIdentity,
  stateFact,
  stateLink,
  withdrawFact,
  withdrawLink,
  type IdentityKey,
} from "../services/human-identity.js";
import { linkPeopleToHumans } from "../services/human-identity-people.js";
import type { HumanFact, HumanLink } from "../db/schema.js";

const router = Router();

type Parsed = { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } };
function firstIssue(...results: Parsed[]): string | null {
  for (const r of results) {
    if (!r.success) {
      const i = r.error?.issues[0];
      return i ? `${i.path.join(".") || "request"}: ${i.message}` : "Invalid request";
    }
  }
  return null;
}

// Known errors -> their status; anything else is a real 500.
function fail(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof InvalidIdentityKeyError || err instanceof FleetMergeNeedsProofError) {
    res.status(400).json({ error: err.message });
  } else if (err instanceof HumanNotFoundError) {
    res.status(404).json({ error: err.message });
  } else if (err instanceof LinkNotFoundError) {
    res.status(404).json({ error: "Link not found in this scope" });
  } else if (err instanceof FactNotFoundError) {
    res.status(404).json({ error: "Fact not found" });
  } else if (err instanceof StillOneHumanError || err instanceof SeparatedHumansError) {
    res.status(409).json({ error: err.message });
  } else {
    next(err);
  }
}

const serializeLink = (l: HumanLink) => ({
  linkId: l.id,
  relation: l.relation,
  scope: l.scope,
  orgId: l.orgId,
  humanIds: [l.aHumanId, l.bHumanId],
  basis: l.basis,
  judgedBy: l.judgedBy,
  statedBy: l.statedBy,
  evidence: l.evidence,
  createdAt: l.createdAt.toISOString(),
});

const serializeFact = (f: HumanFact) => ({
  factId: f.id,
  humanId: f.humanId,
  kind: f.kind,
  statedByOrgId: f.statedByOrgId,
  source: f.source,
  evidence: f.evidence,
  statedAt: f.statedAt.toISOString(),
  withdrawnAt: f.withdrawnAt ? f.withdrawnAt.toISOString() : null,
});

router.post("/internal/human-identities/resolve", requireApiKey, async (req: Request, res: Response, next: NextFunction) => {
  const body = ResolveHumanRequestSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: firstIssue(body) });
    return;
  }
  try {
    const b = body.data;
    const keys: IdentityKey[] = [
      ...(b.emails ?? []).map((v) => ({ kind: "email" as const, valueNorm: normalizeKey("email", v) })),
      ...(b.phones ?? []).map((v) => ({ kind: "phone" as const, valueNorm: normalizeKey("phone", v) })),
      ...(b.linkedinUrls ?? []).map((v) => ({ kind: "linkedin_url" as const, valueNorm: normalizeKey("linkedin_url", v) })),
      ...(b.providerPersonIds ?? []).map((p) => ({
        kind: p.provider === "apollo" ? ("apollo_person_id" as const) : ("apify_person_id" as const),
        valueNorm: normalizeKey("apollo_person_id", p.id),
      })),
      ...(b.messagingHandles ?? []).map((h) => messagingHandleKey(h.network, h.id)),
    ];
    if (keys.length === 0) {
      res.status(400).json({
        error: "at least one email, phone, linkedinUrl, providerPersonId or messagingHandle is required",
      });
      return;
    }
    res.json(await resolveIdentity({ orgId: b.orgId ?? null, keys, source: b.source, create: b.create }));
  } catch (err) {
    fail(err, res, next);
  }
});

router.get("/internal/human-identities/events", requireApiKey, async (req: Request, res: Response, next: NextFunction) => {
  const query = HumanEventsQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: firstIssue(query) });
    return;
  }
  try {
    res.json(
      await listEvents({ after: query.data.after ?? 0, limit: query.data.limit ?? 500, orgId: query.data.orgId ?? null })
    );
  } catch (err) {
    fail(err, res, next);
  }
});

router.post("/internal/human-identities/link-people", requireApiKey, async (req: Request, res: Response, next: NextFunction) => {
  const query = LinkPeopleQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: firstIssue(query) });
    return;
  }
  const dryRun = query.data.dryRun === "true";
  if (query.data.async === "true" && !dryRun) {
    void linkPeopleToHumans({ dryRun: false })
      .then((r) => console.log(`[human-service] human_identity.link_people_done ${JSON.stringify(r)}`))
      .catch((err) => console.error("[human-service] human_identity.link_people_failed", err));
    res.status(202).json({ started: true });
    return;
  }
  try {
    res.json(await linkPeopleToHumans({ dryRun }));
  } catch (err) {
    fail(err, res, next);
  }
});

router.post("/internal/human-identities/links", requireApiKey, async (req: Request, res: Response, next: NextFunction) => {
  const body = StateHumanLinkRequestSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: firstIssue(body) });
    return;
  }
  try {
    const b = body.data;
    const r = await stateLink({
      orgId: b.orgId ?? null,
      relation: b.relation,
      humanIds: [b.humanIds[0], b.humanIds[1]],
      judgedBy: b.judgedBy,
      statedBy: b.statedBy,
      evidence: b.evidence,
    });
    res.json({ changed: r.changed, link: r.link ? serializeLink(r.link) : null, humanIds: r.humanIds });
  } catch (err) {
    fail(err, res, next);
  }
});

router.post("/internal/human-identities/links/:linkId/withdraw", requireApiKey, async (req: Request, res: Response, next: NextFunction) => {
  const params = HumanLinkIdParamsSchema.safeParse(req.params);
  const body = WithdrawHumanLinkRequestSchema.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: firstIssue(params, body) });
    return;
  }
  try {
    const r = await withdrawLink({
      linkId: params.data.linkId,
      orgId: body.data.orgId ?? null,
      withdrawnBy: body.data.withdrawnBy,
      reason: body.data.reason,
    });
    res.json({ changed: r.changed, link: serializeLink(r.link) });
  } catch (err) {
    fail(err, res, next);
  }
});

router.post("/internal/human-identities/facts/:factId/withdraw", requireApiKey, async (req: Request, res: Response, next: NextFunction) => {
  const params = HumanFactIdParamsSchema.safeParse(req.params);
  const body = WithdrawHumanFactRequestSchema.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: firstIssue(params, body) });
    return;
  }
  try {
    const r = await withdrawFact({ factId: params.data.factId, ...body.data });
    res.json({ changed: r.changed, fact: serializeFact(r.fact) });
  } catch (err) {
    fail(err, res, next);
  }
});

router.get("/internal/human-identities/:humanId", requireApiKey, async (req: Request, res: Response, next: NextFunction) => {
  const params = HumanIdParamsSchema.safeParse(req.params);
  const query = HumanViewQuerySchema.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: firstIssue(params, query) });
    return;
  }
  try {
    const view = await getHumanView(params.data.humanId, query.data.orgId ?? null);
    if (!view) {
      res.status(404).json({ error: "Unknown human" });
      return;
    }
    res.json(view);
  } catch (err) {
    fail(err, res, next);
  }
});

router.post("/internal/human-identities/:humanId/facts", requireApiKey, async (req: Request, res: Response, next: NextFunction) => {
  const params = HumanIdParamsSchema.safeParse(req.params);
  const body = StateHumanFactRequestSchema.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: firstIssue(params, body) });
    return;
  }
  try {
    const fact = await stateFact({
      humanId: params.data.humanId,
      kind: body.data.kind,
      statedByOrgId: body.data.statedByOrgId ?? null,
      source: body.data.source,
      evidence: body.data.evidence,
      statedAt: body.data.statedAt ? new Date(body.data.statedAt) : null,
    });
    res.json({ changed: true, fact: serializeFact(fact) });
  } catch (err) {
    fail(err, res, next);
  }
});

export default router;
