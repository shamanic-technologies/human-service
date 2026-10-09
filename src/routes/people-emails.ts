// Internal (service-auth) reads + the explicit attach of a person's email
// addresses. The model and its rules live in src/services/person-emails.ts.
import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import {
  AttachPersonEmailRequestSchema,
  PersonByEmailQuerySchema,
  PersonIdParamsSchema,
  PersonOrgQuerySchema,
} from "../schemas.js";
import {
  EmailHeldByAnotherPersonError,
  PersonNotFoundError,
  attachPersonEmail,
  findPersonByEmail,
  getPersonWithEmails,
} from "../services/person-emails.js";

const router = Router();

function firstIssue(...results: Array<{ success: boolean; error?: { issues: { message: string }[] } }>) {
  for (const r of results) if (!r.success) return r.error?.issues[0]?.message ?? "Invalid request";
  return null;
}

router.get("/internal/people/by-email", requireApiKey, async (req, res) => {
  const query = PersonByEmailQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: firstIssue(query) });
    return;
  }
  res.json({ person: await findPersonByEmail(query.data.orgId, query.data.email) });
});

router.get("/internal/people/:personId", requireApiKey, async (req, res) => {
  const params = PersonIdParamsSchema.safeParse(req.params);
  const query = PersonOrgQuerySchema.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: firstIssue(params, query) });
    return;
  }
  const person = await getPersonWithEmails(query.data.orgId, params.data.personId);
  if (!person) {
    res.status(404).json({ error: "Person not found" });
    return;
  }
  res.json(person);
});

router.post("/internal/people/:personId/emails", requireApiKey, async (req, res) => {
  const params = PersonIdParamsSchema.safeParse(req.params);
  const body = AttachPersonEmailRequestSchema.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: firstIssue(params, body) });
    return;
  }
  try {
    res.json(await attachPersonEmail({ ...body.data, personId: params.data.personId }));
  } catch (err) {
    if (err instanceof PersonNotFoundError) {
      res.status(404).json({ error: "Person not found" });
      return;
    }
    if (err instanceof EmailHeldByAnotherPersonError) {
      res.status(409).json({
        error: `This address belongs to another person (${err.otherPersonId}); attaching an address never merges two people.`,
      });
      return;
    }
    throw err;
  }
});

export default router;
