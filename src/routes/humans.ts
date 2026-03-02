import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { humans } from "../db/schema.js";
import { requireApiKey, requireIdentity } from "../middleware/auth.js";
import { UpsertHumanRequestSchema } from "../schemas.js";

const router = Router();

// POST /humans — Upsert a human expert
router.post("/humans", requireApiKey, requireIdentity, async (req, res) => {
  const parsed = UpsertHumanRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { orgId } = res.locals as { orgId: string };
  const { name, slug, urls, bio, expertise, knownFor, imageUrl, maxPages } =
    parsed.data;

  try {
    // Upsert by (orgId, slug)
    const existing = await db
      .select()
      .from(humans)
      .where(and(eq(humans.orgId, orgId), eq(humans.slug, slug)))
      .limit(1);

    let human;
    let created = false;

    if (existing.length > 0) {
      const [updated] = await db
        .update(humans)
        .set({
          name,
          urls,
          ...(bio !== undefined ? { bio } : {}),
          ...(expertise !== undefined ? { expertise } : {}),
          ...(knownFor !== undefined ? { knownFor } : {}),
          ...(imageUrl !== undefined ? { imageUrl } : {}),
          ...(maxPages !== undefined ? { maxPages } : {}),
          updatedAt: new Date(),
        })
        .where(eq(humans.id, existing[0].id))
        .returning();
      human = updated;
    } else {
      const [inserted] = await db
        .insert(humans)
        .values({
          orgId,
          name,
          slug,
          urls,
          bio: bio ?? null,
          expertise: expertise ?? null,
          knownFor: knownFor ?? null,
          imageUrl: imageUrl ?? null,
          maxPages: maxPages ?? 10,
        })
        .returning();
      human = inserted;
      created = true;
    }

    res.json({ human: serializeHuman(human), created });
  } catch (err) {
    console.error("Error upserting human:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /humans — List humans for an org
router.get("/humans", requireApiKey, requireIdentity, async (req, res) => {
  const { orgId } = res.locals as { orgId: string };

  try {
    const results = await db
      .select()
      .from(humans)
      .where(eq(humans.orgId, orgId));

    res.json({ humans: results.map(serializeHuman) });
  } catch (err) {
    console.error("Error listing humans:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /humans/:id — Get human by ID
router.get("/humans/:id", requireApiKey, async (req, res) => {
  const { id } = req.params;

  try {
    const [human] = await db
      .select()
      .from(humans)
      .where(eq(humans.id, id))
      .limit(1);

    if (!human) {
      res.status(404).json({ error: "Human not found" });
      return;
    }

    res.json({ human: serializeHuman(human) });
  } catch (err) {
    console.error("Error getting human:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

function serializeHuman(human: typeof humans.$inferSelect) {
  return {
    id: human.id,
    name: human.name,
    slug: human.slug,
    bio: human.bio,
    expertise: human.expertise,
    knownFor: human.knownFor,
    imageUrl: human.imageUrl,
    createdAt: human.createdAt.toISOString(),
    updatedAt: human.updatedAt.toISOString(),
  };
}

export default router;
