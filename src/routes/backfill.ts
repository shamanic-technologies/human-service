import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  BackfillPersonasQuerySchema,
  RemapAudienceFiltersQuerySchema,
} from "../schemas.js";
import {
  fetchAllPersonas,
  BrandServiceError,
  BrandConfigError,
} from "../lib/brand-client.js";
import {
  mapPersonaFiltersToCanonical,
  hasPersonaVocab,
  PersonaFilterMapError,
} from "../services/persona-filter-map.js";

const router = Router();

const BACKFILL_SOURCE = "brand_persona_backfill";

// How many before/after samples a dry-run returns (full set is the 26 rows).
const REMAP_SAMPLE_LIMIT = 10;

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

    // Map each persona's filters into the canonical vocabulary BEFORE insert,
    // so backfilled rows are born canonical (no more verbatim persona vocab).
    // Fail loud (502) if any persona blob can't be represented.
    let values;
    try {
      values = toInsert.map((p) => ({
        id: p.id,
        orgId: p.orgId,
        brandId: p.brandId,
        name: p.name,
        filters: mapPersonaFiltersToCanonical(p.filters),
        status: p.status,
        provider: null,
        source: BACKFILL_SOURCE,
      }));
    } catch (err) {
      if (err instanceof PersonaFilterMapError) {
        console.error(`[human-service] backfill.map_error ${err.message}`);
        res.status(502).json({ error: err.message });
        return;
      }
      throw err;
    }

    let insertedCount = 0;
    if (values.length > 0) {
      const inserted = await db
        .insert(audiences)
        .values(values)
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

// POST /internal/remap-audience-filters?dryRun=true|false
//
// One-time DATA fix: translate the filters of already-backfilled audiences
// (source='brand_persona_backfill') from the legacy persona vocabulary into the
// canonical PeopleSearchFilters vocabulary, IN PLACE.
//
// - Scoped to backfilled rows that still contain >=1 persona-vocab key.
// - Idempotent: once a row is canonical it has no persona-vocab key, so a re-run
//   matches nothing (counted as alreadyCanonical) and writes nothing.
// - Dry-runnable: ?dryRun=true reports counts + per-row before/after sample,
//   writes nothing.
// - Reversible: rows stay tagged source='brand_persona_backfill'; brand-service
//   personas (the source of truth) are untouched, so the canonical state is fully
//   reconstructable (DELETE WHERE source=... + re-run the now-canonical backfill).
//
// Fail loud: an unrepresentable persona value -> PersonaFilterMapError -> 502.
//
// Service-auth only (x-api-key); sweeps all orgs.
router.post(
  "/internal/remap-audience-filters",
  requireApiKey,
  async (req, res) => {
    const parsedQuery = RemapAudienceFiltersQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.message });
      return;
    }
    const dryRun = parsedQuery.data.dryRun === "true";

    const rows = await db
      .select({
        id: audiences.id,
        name: audiences.name,
        filters: audiences.filters,
      })
      .from(audiences)
      .where(eq(audiences.source, BACKFILL_SOURCE));

    const scanned = rows.length;
    let alreadyCanonical = 0;
    const toMap: Array<{
      id: string;
      name: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }> = [];

    try {
      for (const row of rows) {
        const before = (row.filters ?? {}) as Record<string, unknown>;
        if (!hasPersonaVocab(before)) {
          alreadyCanonical++;
          continue;
        }
        toMap.push({
          id: row.id,
          name: row.name,
          before,
          after: mapPersonaFiltersToCanonical(before),
        });
      }
    } catch (err) {
      if (err instanceof PersonaFilterMapError) {
        console.error(`[human-service] remap.map_error ${err.message}`);
        res.status(502).json({ error: err.message });
        return;
      }
      throw err;
    }

    const sample = toMap
      .slice(0, REMAP_SAMPLE_LIMIT)
      .map(({ id, name, before, after }) => ({ id, name, before, after }));

    if (dryRun) {
      console.log(
        `[human-service] remap.dry_run scanned=${scanned} would_remap=${toMap.length} already_canonical=${alreadyCanonical}`
      );
      res.json({
        dryRun: true,
        scanned,
        remapped: 0,
        wouldRemap: toMap.length,
        alreadyCanonical,
        sample,
      });
      return;
    }

    for (const row of toMap) {
      await db
        .update(audiences)
        .set({ filters: row.after, updatedAt: new Date() })
        .where(eq(audiences.id, row.id));
    }

    console.log(
      `[human-service] remap.run scanned=${scanned} remapped=${toMap.length} already_canonical=${alreadyCanonical}`
    );
    res.json({
      dryRun: false,
      scanned,
      remapped: toMap.length,
      wouldRemap: toMap.length,
      alreadyCanonical,
      sample,
    });
  }
);

export default router;
