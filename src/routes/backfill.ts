import { Router } from "express";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  RemapAudienceFiltersQuerySchema,
  BackfillAudienceDescriptionsQuerySchema,
  MigrateApifyAudiencesQuerySchema,
} from "../schemas.js";
import {
  mapPersonaFiltersToCanonical,
  hasPersonaVocab,
  PersonaFilterMapError,
} from "../services/persona-filter-map.js";
import {
  generateAudienceDescription,
  migrateApifyAudienceToApollo,
  type ApifyToApolloMigrationResult,
} from "../services/audiences.js";
import { ChatConfigError, ChatServiceError } from "../lib/chat-client.js";
import { ProviderConfigError } from "../services/people-providers.js";

const router = Router();

const BACKFILL_SOURCE = "brand_persona_backfill";

// How many before/after samples a dry-run returns (full set is the 26 rows).
const REMAP_SAMPLE_LIMIT = 10;

// How many {id,name,description} previews the description backfill returns.
const DESC_SAMPLE_LIMIT = 10;

// POST /internal/backfill-audience-descriptions?dryRun=true|false
//
// One-time DATA fix: #82 added + persisted a per-audience `description`, but rows
// created BEFORE it have description=null, so the dashboard "Described as" line
// stays blank for them. This sweep generates a one-sentence description from each
// such row's OWN name + filters (via chat-service, which owns the LLM cost) and
// writes it. The shared batch `nlPrompt` is deliberately NEVER used as the
// fallback (that is exactly what #82 stopped doing).
//
// - Scoped to `description IS NULL` rows -> idempotent: a re-run only sees rows
//   still null, so already-described audiences are untouched and a clean re-run
//   reports backfilled=0.
// - Dry-runnable: ?dryRun=true counts the null rows + returns an {id,name} sample
//   WITHOUT calling the LLM or writing (so a preview costs nothing).
// - Per-row resilience: a row whose generation yields no usable description is
//   logged + counted in `failed` + left null (retried on the next re-run). A real
//   chat-service outage / missing config aborts the sweep loudly (502); partial
//   progress persists and a re-run resumes (only null rows remain).
//
// Service-auth only (x-api-key); org-less platform LLM path; sweeps all orgs.
// Trigger MANUALLY after deploy — never on boot (O(N) over the table x one LLM
// call each would block port-bind).
router.post(
  "/internal/backfill-audience-descriptions",
  requireApiKey,
  async (req, res) => {
    const parsedQuery = BackfillAudienceDescriptionsQuerySchema.safeParse(
      req.query
    );
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
      .where(isNull(audiences.description));

    const scanned = rows.length;

    if (dryRun) {
      const sample = rows
        .slice(0, DESC_SAMPLE_LIMIT)
        .map((r) => ({ id: r.id, name: r.name, description: null }));
      console.log(
        `[human-service] backfill_desc.dry_run scanned=${scanned}`
      );
      res.json({
        dryRun: true,
        scanned,
        wouldBackfill: scanned,
        backfilled: 0,
        failed: [],
        sample,
      });
      return;
    }

    let backfilled = 0;
    const failed: Array<{ id: string; name: string; error: string }> = [];
    const sample: Array<{ id: string; name: string; description: string }> = [];

    for (const row of rows) {
      let description: string;
      try {
        description = await generateAudienceDescription({
          name: row.name,
          filters: row.filters,
        });
      } catch (err) {
        // Deploy misconfig (missing CHAT_SERVICE_* env) or chat-service
        // unreachable (transport throw -> status 0): systemic, not this row's
        // fault -> fail loud + abort. Already-written rows persist; a re-run
        // resumes since only null-description rows remain.
        if (
          err instanceof ChatConfigError ||
          (err instanceof ChatServiceError && err.status === 0)
        ) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[human-service] backfill_desc.abort ${msg}`);
          res.status(502).json({ error: msg, backfilled, failed });
          return;
        }
        // Per-row generation failure (empty/malformed LLM output, transient
        // chat error): log + skip; the row stays null and is retried on re-run.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[human-service] backfill_desc.row_failed id=${row.id} ${msg}`
        );
        failed.push({ id: row.id, name: row.name, error: msg });
        continue;
      }

      await db
        .update(audiences)
        .set({ description, updatedAt: new Date() })
        .where(eq(audiences.id, row.id));
      backfilled++;
      if (sample.length < DESC_SAMPLE_LIMIT) {
        sample.push({ id: row.id, name: row.name, description });
      }
    }

    console.log(
      `[human-service] backfill_desc.run scanned=${scanned} backfilled=${backfilled} failed=${failed.length}`
    );
    res.json({
      dryRun: false,
      scanned,
      wouldBackfill: scanned,
      backfilled,
      failed,
      sample,
    });
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

// How many {id,name,status} previews the apify→apollo migration returns.
const MIGRATE_SAMPLE_LIMIT = 25;

class MigrationAborted extends Error {
  constructor(
    message: string,
    readonly migrated: ApifyToApolloMigrationResult[],
    readonly failed: Array<{ id: string; name: string; error: string }>
  ) {
    super(message);
    this.name = "MigrationAborted";
  }
}

// Migrate a batch of apify rows to apollo, one atomic txn each. A row whose
// apollo re-derivation yields no usable filter set is per-row `failed` (left
// untouched, retried on re-run). A SYSTEMIC error (apollo/chat outage / missing
// config) throws `MigrationAborted` carrying the partial progress — every row
// already migrated persists (its own committed txn), a re-run resumes.
async function runApifyToApolloMigration(
  rows: Array<typeof audiences.$inferSelect>
): Promise<{
  migrated: ApifyToApolloMigrationResult[];
  failed: Array<{ id: string; name: string; error: string }>;
}> {
  const migrated: ApifyToApolloMigrationResult[] = [];
  const failed: Array<{ id: string; name: string; error: string }> = [];
  for (const row of rows) {
    let result: ApifyToApolloMigrationResult | null;
    try {
      result = await migrateApifyAudienceToApollo(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // ONLY a missing-config error is truly systemic (every row would fail the
      // same way) -> abort the sweep. A per-audience provider/LLM hiccup
      // (apollo 5xx, chat 502/unreachable, a flaky refine) must NOT halt the
      // whole sweep: log it, count it failed, and keep migrating the rest. The
      // failed row stays apify (untouched) and is retried on the next re-run.
      if (
        err instanceof ChatConfigError ||
        err instanceof ProviderConfigError
      ) {
        console.error(`[human-service] migrate_apify.abort id=${row.id} ${msg}`);
        throw new MigrationAborted(msg, migrated, failed);
      }
      console.warn(
        `[human-service] migrate_apify.row_failed id=${row.id} ${msg}`
      );
      failed.push({ id: row.id, name: row.name, error: msg });
      continue;
    }
    if (!result) {
      console.warn(
        `[human-service] migrate_apify.row_failed id=${row.id} no usable apollo filters`
      );
      failed.push({
        id: row.id,
        name: row.name,
        error: "apollo re-derivation yielded no usable filter set",
      });
      continue;
    }
    migrated.push(result);
  }
  return { migrated, failed };
}

// POST /internal/migrate-apify-audiences-to-apollo?dryRun=true|false
//
// One-time DATA fix: the people gateway is now apollo-only (apify removed from
// the suggest fan-out + default routing). This sweep retires every existing
// apify audience and replaces it with an equivalent APOLLO audience. The apify
// filters are NOT copied — apollo and apify tune the neutral filter set
// differently (esp. apollo's `industries` taxonomy), so we re-derive apollo
// filters via the agentic refine loop (LLM on the org-less platform path — no
// org bill — apollo dry-runs via each audience's creator identity), then create
// a new apollo audience MIRRORING the source status and mark the apify one
// `deprecated` (terminal, hidden from the dashboard, non-reactivable).
//
// - Scoped to provider='apify' AND status<>'deprecated' -> idempotent: a re-run
//   skips already-migrated rows (they are now deprecated), so a clean re-run
//   migrates 0.
// - Dry-runnable: ?dryRun=true counts the apify rows + returns an {id,name,status}
//   sample WITHOUT calling the LLM/apollo or writing (free preview).
// - Reversible: new apollo rows are tagged source='migrated_from_apify'; undo by
//   DELETE WHERE source=that + un-rename/un-deprecate the apify rows.
// - Per-row resilience: a row whose apollo re-derivation yields no usable filter
//   set is counted in `failed` + left untouched (retried on re-run). A real
//   apollo/chat-service outage / missing config aborts the sweep loudly (502);
//   already-migrated rows persist (each migration is one atomic transaction).
//
// Service-auth only (x-api-key); sweeps all orgs. Trigger MANUALLY after deploy —
// never on boot (O(N) over the table x an agentic LLM loop each would block
// port-bind).
router.post(
  "/internal/migrate-apify-audiences-to-apollo",
  requireApiKey,
  async (req, res) => {
    const parsedQuery = MigrateApifyAudiencesQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.message });
      return;
    }
    const dryRun = parsedQuery.data.dryRun === "true";
    // Each row's agentic refine (up to 8 LLM rounds + apollo dry-runs) can exceed
    // a caller's HTTP timeout, and a whole-table sweep certainly does. `async=true`
    // decouples the work from the request: respond 202 immediately, then run the
    // sweep in the background (each row is its own committed txn, so progress is
    // durable + observable via ?dryRun=true). Poll until scanned hits 0.
    const asyncMode = parsedQuery.data.async === "true";

    const rows = await db
      .select()
      .from(audiences)
      .where(
        and(eq(audiences.provider, "apify"), ne(audiences.status, "deprecated"))
      );

    const scanned = rows.length;

    if (dryRun) {
      const sample = rows
        .slice(0, MIGRATE_SAMPLE_LIMIT)
        .map((r) => ({ id: r.id, name: r.name, status: r.status }));
      console.log(
        `[human-service] migrate_apify.dry_run scanned=${scanned}`
      );
      res.json({
        dryRun: true,
        scanned,
        wouldMigrate: scanned,
        migrated: [],
        failed: [],
        sample,
      });
      return;
    }

    if (asyncMode) {
      // Fire-and-forget: respond before the sweep so the work survives a caller
      // timeout. Progress is durable (per-row txn) and observable via dry-run.
      res.status(202).json({ started: true, scanned });
      void runApifyToApolloMigration(rows)
        .then(({ migrated, failed }) =>
          console.log(
            `[human-service] migrate_apify.run_async scanned=${scanned} migrated=${migrated.length} failed=${failed.length}`
          )
        )
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[human-service] migrate_apify.run_async_aborted ${msg}`);
        });
      return;
    }

    try {
      const { migrated, failed } = await runApifyToApolloMigration(rows);
      console.log(
        `[human-service] migrate_apify.run scanned=${scanned} migrated=${migrated.length} failed=${failed.length}`
      );
      res.json({
        dryRun: false,
        scanned,
        wouldMigrate: scanned,
        migrated,
        failed,
        sample: [],
      });
    } catch (err) {
      // Systemic apollo/chat outage -> fail loud (502). Already-migrated rows
      // persist; a re-run resumes (migrated rows are now deprecated, skipped).
      if (err instanceof MigrationAborted) {
        res.status(502).json({
          error: err.message,
          migrated: err.migrated,
          failed: err.failed,
        });
        return;
      }
      throw err;
    }
  }
);

export default router;
