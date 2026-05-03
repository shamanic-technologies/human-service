import { Router } from "express";
import { and, eq, count, asc } from "drizzle-orm";
import { db } from "../db/index.js";
import { lists, listMembers } from "../db/schema.js";
import { requireApiKey, requireOrgIdOnly } from "../middleware/auth.js";
import {
  CreateListRequestSchema,
  UpdateListRequestSchema,
  ListListsQuerySchema,
  ListMembersQuerySchema,
  BulkAddMembersRequestSchema,
  BulkRemoveMembersRequestSchema,
} from "../schemas.js";

const router = Router();

const DEFAULT_LIMIT = 50;
const DEFAULT_MEMBERS_LIMIT = 100;

// --- POST /orgs/lists ---
router.post("/orgs/lists", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const parsed = CreateListRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const orgId = res.locals.orgId as string;
  const userId = (res.locals.userId as string | undefined) ?? null;

  const [list] = await db
    .insert(lists)
    .values({
      orgId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      brandId: parsed.data.brandId ?? null,
      createdByUserId: userId,
    })
    .returning();

  console.log(
    `[human-service] list.create org=${orgId} list=${list.id} brand=${list.brandId ?? "none"}`
  );

  res.status(201).json({ list: serializeList(list) });
});

// --- GET /orgs/lists ---
router.get("/orgs/lists", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const parsedQuery = ListListsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: parsedQuery.error.message });
    return;
  }

  const orgId = res.locals.orgId as string;
  const limit = parsedQuery.data.limit ?? DEFAULT_LIMIT;
  const offset = parsedQuery.data.offset ?? 0;
  const brandFilter = parsedQuery.data.brandId;

  const whereClause = brandFilter
    ? and(eq(lists.orgId, orgId), eq(lists.brandId, brandFilter))
    : eq(lists.orgId, orgId);

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(lists)
      .where(whereClause)
      .orderBy(asc(lists.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(lists).where(whereClause),
  ]);

  res.json({
    lists: rows.map(serializeList),
    total: totalRows[0]?.value ?? 0,
    limit,
    offset,
  });
});

// --- GET /orgs/lists/:id ---
router.get("/orgs/lists/:id", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const orgId = res.locals.orgId as string;

  const [list] = await db
    .select()
    .from(lists)
    .where(and(eq(lists.id, req.params.id), eq(lists.orgId, orgId)))
    .limit(1);

  if (!list) {
    res.status(404).json({ error: "List not found" });
    return;
  }

  res.json({ list: serializeList(list) });
});

// --- PATCH /orgs/lists/:id ---
router.patch("/orgs/lists/:id", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const parsed = UpdateListRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const orgId = res.locals.orgId as string;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.brandId !== undefined) updates.brandId = parsed.data.brandId;

  const [updated] = await db
    .update(lists)
    .set(updates)
    .where(and(eq(lists.id, req.params.id), eq(lists.orgId, orgId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "List not found" });
    return;
  }

  res.json({ list: serializeList(updated) });
});

// --- DELETE /orgs/lists/:id ---
router.delete("/orgs/lists/:id", requireApiKey, requireOrgIdOnly, async (req, res) => {
  const orgId = res.locals.orgId as string;

  const deleted = await db
    .delete(lists)
    .where(and(eq(lists.id, req.params.id), eq(lists.orgId, orgId)))
    .returning({ id: lists.id });

  if (deleted.length === 0) {
    res.status(404).json({ error: "List not found" });
    return;
  }

  console.log(`[human-service] list.delete org=${orgId} list=${req.params.id}`);
  res.status(204).send();
});

// --- GET /orgs/lists/:id/members ---
router.get(
  "/orgs/lists/:id/members",
  requireApiKey,
  requireOrgIdOnly,
  async (req, res) => {
    const parsedQuery = ListMembersQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.message });
      return;
    }

    const orgId = res.locals.orgId as string;
    const listId = req.params.id;

    const list = await ensureListInOrg(listId, orgId);
    if (!list) {
      res.status(404).json({ error: "List not found" });
      return;
    }

    const limit = parsedQuery.data.limit ?? DEFAULT_MEMBERS_LIMIT;
    const offset = parsedQuery.data.offset ?? 0;
    const whereClause = and(
      eq(listMembers.listId, listId),
      eq(listMembers.orgId, orgId)
    );

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(listMembers)
        .where(whereClause)
        .orderBy(asc(listMembers.addedAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(listMembers).where(whereClause),
    ]);

    res.json({
      members: rows.map(serializeMember),
      total: totalRows[0]?.value ?? 0,
      limit,
      offset,
    });
  }
);

// --- POST /orgs/lists/:id/members (bulk add, idempotent) ---
router.post(
  "/orgs/lists/:id/members",
  requireApiKey,
  requireOrgIdOnly,
  async (req, res) => {
    const parsed = BulkAddMembersRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const orgId = res.locals.orgId as string;
    const userId = (res.locals.userId as string | undefined) ?? null;
    const listId = req.params.id;

    const list = await ensureListInOrg(listId, orgId);
    if (!list) {
      res.status(404).json({ error: "List not found" });
      return;
    }

    // Dedup the input itself on (sourceService, sourceResourceId) to keep
    // the unique-constraint conflict count predictable.
    const seen = new Set<string>();
    const rowsToInsert = parsed.data.members
      .map((m) => ({
        orgId,
        listId,
        sourceService: m.sourceService ?? "google-service",
        sourceResourceId: m.sourceResourceId,
        sourceAccountId: m.sourceAccountId ?? null,
        addedByUserId: userId,
      }))
      .filter((row) => {
        const key = `${row.sourceService}::${row.sourceResourceId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    const inserted = await db
      .insert(listMembers)
      .values(rowsToInsert)
      .onConflictDoNothing({
        target: [
          listMembers.listId,
          listMembers.sourceService,
          listMembers.sourceResourceId,
        ],
      })
      .returning({ id: listMembers.id });

    const added = inserted.length;
    const skipped = parsed.data.members.length - added;

    console.log(
      `[human-service] list.members.add org=${orgId} list=${listId} requested=${parsed.data.members.length} added=${added} skipped=${skipped}`
    );

    res.json({ added, skipped });
  }
);

// --- DELETE /orgs/lists/:id/members (bulk remove) ---
router.delete(
  "/orgs/lists/:id/members",
  requireApiKey,
  requireOrgIdOnly,
  async (req, res) => {
    const parsed = BulkRemoveMembersRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const orgId = res.locals.orgId as string;
    const listId = req.params.id;

    const list = await ensureListInOrg(listId, orgId);
    if (!list) {
      res.status(404).json({ error: "List not found" });
      return;
    }

    let removed = 0;
    for (const m of parsed.data.members) {
      const sourceService = m.sourceService ?? "google-service";
      const result = await db
        .delete(listMembers)
        .where(
          and(
            eq(listMembers.listId, listId),
            eq(listMembers.orgId, orgId),
            eq(listMembers.sourceService, sourceService),
            eq(listMembers.sourceResourceId, m.sourceResourceId)
          )
        )
        .returning({ id: listMembers.id });
      if (result.length > 0) removed += 1;
    }

    const notFound = parsed.data.members.length - removed;

    console.log(
      `[human-service] list.members.remove org=${orgId} list=${listId} requested=${parsed.data.members.length} removed=${removed} notFound=${notFound}`
    );

    res.json({ removed, notFound });
  }
);

// --- helpers ---

async function ensureListInOrg(
  listId: string,
  orgId: string
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: lists.id })
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

function serializeList(row: typeof lists.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    brandId: row.brandId,
    name: row.name,
    description: row.description,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeMember(row: typeof listMembers.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    listId: row.listId,
    sourceService: row.sourceService,
    sourceResourceId: row.sourceResourceId,
    sourceAccountId: row.sourceAccountId,
    humanId: row.humanId,
    addedByUserId: row.addedByUserId,
    addedAt: row.addedAt.toISOString(),
  };
}

export default router;
