import { Router } from "express";
import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { BackfillPersonasQuerySchema } from "../schemas.js";
import {
  fetchAllPersonas,
  BrandServiceError,
  BrandConfigError,
} from "../lib/brand-client.js";

const router = Router();

const BACKFILL_SOURCE = "brand_persona_backfill";

// POST /internal/backfill-audiences-from-personas?dryRun=true|false
//
// One-time migration: copy every brand-service persona into `audiences`,
// PRESERVING THE PERSONA ID AS THE AUDIENCE ID (downstream cost/outcome evidence
// is keyed on it). Carries org + brand + name + filters + status.
//
// - Idempotent: a persona whose id already exists as an audience is skipped
//   (ON CONFLICT (id) DO NOTHING). Re-running is a no-op.
// - Dry-runnable: ?dryRun=true reports counts without writing.
// - Reversible: inserted rows are tagged source='brand_persona_backfill' so they
//   can be identified and undone (DELETE FROM audiences WHERE source = ...).
//
// Service-auth only (x-api-key); there is no per-org scope — it sweeps all orgs.
router.post(
  "/internal/backfill-audiences-from-personas",
  requireApiKey,
  async (req, res) => {
    const parsedQuery = BackfillPersonasQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.message });
      return;
    }
    const dryRun = parsedQuery.data.dryRun === "true";

    let personas;
    try {
      personas = await fetchAllPersonas();
    } catch (err) {
      if (err instanceof BrandConfigError) {
        res.status(502).json({ error: err.message });
        return;
      }
      if (err instanceof BrandServiceError) {
        console.error(
          `[human-service] backfill.brand_error status=${err.status}`
        );
        res
          .status(502)
          .json({ error: err.message, upstreamStatus: err.status });
        return;
      }
      throw err;
    }

    const totalPersonas = personas.length;

    // Which persona ids already exist as audiences (idempotency check).
    const ids = personas.map((p) => p.id);
    const existingRows =
      ids.length > 0
        ? await db
            .select({ id: audiences.id })
            .from(audiences)
            .where(inArray(audiences.id, ids))
        : [];
    const existing = new Set(existingRows.map((r) => r.id));
    const toInsert = personas.filter((p) => !existing.has(p.id));

    if (dryRun) {
      console.log(
        `[human-service] backfill.dry_run total=${totalPersonas} would_insert=${toInsert.length} skip=${existing.size}`
      );
      res.json({
        dryRun: true,
        totalPersonas,
        inserted: 0,
        skipped: existing.size,
      });
      return;
    }

    let insertedCount = 0;
    if (toInsert.length > 0) {
      const inserted = await db
        .insert(audiences)
        .values(
          toInsert.map((p) => ({
            id: p.id,
            orgId: p.orgId,
            brandId: p.brandId,
            name: p.name,
            filters: p.filters,
            status: p.status,
            provider: null,
            source: BACKFILL_SOURCE,
          }))
        )
        .onConflictDoNothing({ target: audiences.id })
        .returning({ id: audiences.id });
      insertedCount = inserted.length;
    }

    const skipped = totalPersonas - insertedCount;
    console.log(
      `[human-service] backfill.run total=${totalPersonas} inserted=${insertedCount} skipped=${skipped}`
    );
    res.json({ dryRun: false, totalPersonas, inserted: insertedCount, skipped });
  }
);

export default router;
