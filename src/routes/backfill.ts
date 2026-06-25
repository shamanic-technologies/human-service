import { Router } from "express";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audiences } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  RemapAudienceFiltersQuerySchema,
  BackfillAudienceDescriptionsQuerySchema,
  MigrateApifyAudiencesQuerySchema,
  BackfillAudienceAvatarsQuerySchema,
  BackfillCanonicalLinksQuerySchema,
  BackfillApolloPointersQuerySchema,
} from "../schemas.js";
import {
  mapPersonaFiltersToCanonical,
  hasPersonaVocab,
  PersonaFilterMapError,
} from "../services/persona-filter-map.js";
import {
  generateAudienceDescription,
  migrateApifyAudienceToApollo,
  linkCanonicalForDeprecated,
  buildAvatarPrompt,
  generateAudienceAvatarViaPlatform,
  convertAudienceDataUriAvatarViaPlatform,
  backfillApolloAudiencePointer,
  type ApifyToApolloMigrationResult,
  type ApolloPointerBackfillResult,
} from "../services/audiences.js";
import { ChatConfigError, ChatServiceError } from "../lib/chat-client.js";
import {
  CloudflareConfigError,
} from "../lib/cloudflare-client.js";
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

// How many {id,name} previews the avatar backfill returns.
const AVATAR_SAMPLE_LIMIT = 25;

// Generate + store a flat-vector avatar for avatar-less audiences, and convert
// legacy data URI avatars to Cloudflare URLs. A per-row image/upload failure is
// logged + counted in `failed`; missing service config aborts the sweep loud
// (502) because every row would fail identically.
async function runAvatarBackfill(
  rows: Array<typeof audiences.$inferSelect>
): Promise<{
  filled: number;
  failed: Array<{ id: string; name: string; error: string }>;
}> {
  let filled = 0;
  const failed: Array<{ id: string; name: string; error: string }> = [];
  for (const row of rows) {
    try {
      if (row.avatarUrl?.startsWith("data:")) {
        await convertAudienceDataUriAvatarViaPlatform(row);
      } else {
        const prompt = buildAvatarPrompt(row);
        await generateAudienceAvatarViaPlatform(row.orgId, row.id, prompt);
      }
      filled++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ChatConfigError || err instanceof CloudflareConfigError) {
        console.error(`[human-service] backfill_avatars.abort id=${row.id} ${msg}`);
        throw new MigrationAborted(msg, [], failed);
      }
      console.warn(
        `[human-service] backfill_avatars.row_failed id=${row.id} ${msg}`
      );
      failed.push({ id: row.id, name: row.name, error: msg });
    }
  }
  return { filled, failed };
}

// POST /internal/backfill-audience-avatars?dryRun=true|false&async=true|false
//
// One-time DATA fix: generate + store a flat-vector avatar URL for every LIVE
// audience whose avatar_url is null, and convert existing data URI avatar rows
// to Cloudflare URLs. Swept server-side over all orgs.
//
// - Scoped to status<>'deprecated' AND (avatar_url IS NULL OR avatar_url LIKE
//   'data:%') -> idempotent (a re-run only sees rows still null / still inline).
//   NO created_by_user_id requirement: platform paths need no org/user.
// - Dry-runnable: ?dryRun=true counts + samples WITHOUT calling chat-service.
// - Async: ?async=true responds 202 then runs in the background (image gen is
//   slow; a whole-table run exceeds an HTTP timeout). Each row is its own write,
//   so progress is durable + observable via dry-run.
// - COST: image gen runs on the platform path (chat-service declares it on a
//   PLATFORM run) — NO org is billed. A transient chat failure → per-row skip
//   (reported in `failed`), not a sweep abort.
//
// Service-auth only (x-api-key). Trigger MANUALLY after deploy — never on boot.
router.post(
  "/internal/backfill-audience-avatars",
  requireApiKey,
  async (req, res) => {
    const parsedQuery = BackfillAudienceAvatarsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.message });
      return;
    }
    const dryRun = parsedQuery.data.dryRun === "true";
    const asyncMode = parsedQuery.data.async === "true";

    const rows = await db
      .select()
      .from(audiences)
      .where(
        and(
          ne(audiences.status, "deprecated"),
          or(
            isNull(audiences.avatarUrl),
            sql`${audiences.avatarUrl} LIKE 'data:%'`
          )
        )
      );

    const scanned = rows.length;

    if (dryRun) {
      const sample = rows
        .slice(0, AVATAR_SAMPLE_LIMIT)
        .map((r) => ({ id: r.id, name: r.name }));
      console.log(
        `[human-service] backfill_avatars.dry_run scanned=${scanned}`
      );
      res.json({
        dryRun: true,
        scanned,
        wouldFill: scanned,
        filled: 0,
        failed: [],
        sample,
      });
      return;
    }

    if (asyncMode) {
      res.status(202).json({
        dryRun: false,
        started: true,
        scanned,
        wouldFill: scanned,
        filled: 0,
        failed: [],
        sample: [],
      });
      void runAvatarBackfill(rows)
        .then(({ filled, failed }) =>
          console.log(
            `[human-service] backfill_avatars.run_async scanned=${scanned} filled=${filled} failed=${failed.length}`
          )
        )
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[human-service] backfill_avatars.run_async_aborted ${msg}`);
        });
      return;
    }

    try {
      const { filled, failed } = await runAvatarBackfill(rows);
      console.log(
        `[human-service] backfill_avatars.run scanned=${scanned} filled=${filled} failed=${failed.length}`
      );
      res.json({
        dryRun: false,
        scanned,
        wouldFill: scanned,
        filled,
        failed,
        sample: [],
      });
    } catch (err) {
      if (err instanceof MigrationAborted) {
        res.status(502).json({ error: err.message, failed: err.failed });
        return;
      }
      throw err;
    }
  }
);

// How many {id,name,canonicalAudienceId} previews the canonical-link backfill returns.
const CANONICAL_SAMPLE_LIMIT = 25;

// POST /internal/backfill-canonical-audience-links?dryRun=true|false
//
// One-time DATA fix: the apify->apollo migration deprecated + renamed each apify
// audience "<base> [Apify]" and created an active apollo twin "<base>" but stored
// NO link between them, so consumers that resolve a lead's audience from
// membership land on the deprecated provider-variant (retired name, no avatar).
// This sweep sets `canonical_audience_id` on each deprecated provider-variant row,
// pointing at its active same-(org,brand)-base-name sibling, so membership/stats
// reads resolve to the clean active audience.
//
// - Scoped to status='deprecated' AND canonical_audience_id IS NULL -> idempotent:
//   a re-run only sees still-unlinked rows (a clean re-run links 0).
// - Dry-runnable: ?dryRun=true resolves the would-be links + returns counts +
//   a sample WITHOUT writing.
// - Reversible: undo by UPDATE audiences SET canonical_audience_id=NULL WHERE
//   status='deprecated'.
// - FAIL LOUD on ambiguity: a deprecated row with no provider-variant suffix, no
//   active sibling, or (defensively) >1 sibling is SKIPPED + logged, never guessed.
//
// Service-auth only (x-api-key); sweeps all orgs. Cheap (pure SQL, no LLM), but
// still trigger MANUALLY after deploy — never on boot (O(N) over the table).
router.post(
  "/internal/backfill-canonical-audience-links",
  requireApiKey,
  async (req, res) => {
    const parsedQuery = BackfillCanonicalLinksQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.message });
      return;
    }
    const dryRun = parsedQuery.data.dryRun === "true";

    const rows = await db
      .select({
        id: audiences.id,
        orgId: audiences.orgId,
        brandId: audiences.brandId,
        name: audiences.name,
      })
      .from(audiences)
      .where(
        and(
          eq(audiences.status, "deprecated"),
          isNull(audiences.canonicalAudienceId)
        )
      );

    const scanned = rows.length;
    const linkedSamples: Array<{
      id: string;
      name: string;
      canonicalAudienceId: string;
    }> = [];
    const skipped: Array<{ id: string; name: string; reason: string }> = [];

    for (const row of rows) {
      const outcome = await linkCanonicalForDeprecated(row, { dryRun });
      if (outcome.status === "linked") {
        linkedSamples.push({
          id: outcome.id,
          name: outcome.name,
          canonicalAudienceId: outcome.canonicalAudienceId,
        });
      } else {
        console.warn(
          `[human-service] backfill_canonical.skip id=${outcome.id} ${outcome.reason}`
        );
        skipped.push({
          id: outcome.id,
          name: outcome.name,
          reason: outcome.reason,
        });
      }
    }

    const wouldLink = linkedSamples.length;
    console.log(
      `[human-service] backfill_canonical.${dryRun ? "dry_run" : "run"} scanned=${scanned} ${dryRun ? "wouldLink" : "linked"}=${wouldLink} skipped=${skipped.length}`
    );

    res.json({
      dryRun,
      scanned,
      linked: dryRun ? 0 : wouldLink,
      wouldLink,
      skipped,
      sample: linkedSamples.slice(0, CANONICAL_SAMPLE_LIMIT),
    });
  }
);

// How many {id,name} previews the apollo-pointer backfill returns.
const APOLLO_POINTER_SAMPLE_LIMIT = 25;

// Build a faithful apollo audience (via apollo-service) + store its pointer for a
// batch of apollo audiences lacking one, one row at a time. A row whose
// apollo-service build yields no usable filter set OR fails transiently is per-row
// `failed` (left untouched, retried on re-run). A SYSTEMIC error (apollo env
// missing) throws `MigrationAborted` carrying the partial progress — every row
// already pointed persists, a re-run resumes.
async function runApolloPointerBackfill(
  rows: Array<typeof audiences.$inferSelect>
): Promise<{
  backfilled: ApolloPointerBackfillResult[];
  failed: Array<{ id: string; name: string; error: string }>;
}> {
  const backfilled: ApolloPointerBackfillResult[] = [];
  const failed: Array<{ id: string; name: string; error: string }> = [];
  for (const row of rows) {
    let result: ApolloPointerBackfillResult | null;
    try {
      result = await backfillApolloAudiencePointer(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only a missing-config error is truly systemic (every row fails the same
      // way) -> abort. A per-row apollo hiccup (5xx, transient) is logged, counted
      // failed, and the sweep continues; the row stays pointer-less, retried later.
      if (err instanceof ProviderConfigError) {
        console.error(`[human-service] backfill_apollo_ptr.abort id=${row.id} ${msg}`);
        throw new MigrationAborted(msg, [], failed);
      }
      console.warn(
        `[human-service] backfill_apollo_ptr.row_failed id=${row.id} ${msg}`
      );
      failed.push({ id: row.id, name: row.name, error: msg });
      continue;
    }
    if (!result) {
      console.warn(
        `[human-service] backfill_apollo_ptr.row_failed id=${row.id} no usable apollo filters`
      );
      failed.push({
        id: row.id,
        name: row.name,
        error: "apollo-service build yielded no usable filter set",
      });
      continue;
    }
    backfilled.push(result);
  }
  return { backfilled, failed };
}

// POST /internal/backfill-apollo-audience-pointers?dryRun=true|false&async=true|false
//
// One-time DATA fix ("one filter vocabulary" Wave 2): human-service stops holding
// Apollo's filter vocabulary. Pre-Wave-2 apollo audiences hold a human-built /
// lossy neutral filter blob and NO apollo_audience_id. This sweep asks apollo-
// service to BUILD a faithful Apollo audience from each row's own name +
// description, then stores the POINTER + the faithful filters (cached, replacing
// the old neutral blob) + the count.
//
// - Scoped to provider='apollo' AND apollo_audience_id IS NULL AND status<>'deprecated'
//   -> idempotent: a re-run only sees still-pointer-less rows (a clean re-run
//   backfills 0). apify (legacy) rows are NOT touched (they keep their own filters).
// - Dry-runnable: ?dryRun=true counts the rows + returns an {id,name} sample
//   WITHOUT calling apollo-service or writing (free preview).
// - Async: ?async=true responds 202 then runs in the background (each row triggers
//   apollo-service's agentic refine loop; a whole-table run exceeds an HTTP
//   timeout). Each row is its own write, so progress is durable + observable via
//   dry-run.
// - Reversible: undo by UPDATE audiences SET apollo_audience_id=NULL WHERE ... (the
//   cached faithful filters are the intended improvement — the old neutral apollo
//   blob was exactly the lossy vocabulary this wave removes).
// - Per-row resilience: a row whose build yields no usable filter set / fails
//   transiently is counted in `failed` + left untouched (retried on re-run); a
//   missing apollo config aborts the sweep loudly (502).
//
// Service-auth only (x-api-key); sweeps all orgs. Trigger MANUALLY after deploy —
// never on boot (O(N) over the table x an apollo agentic refine each would block
// port-bind).
router.post(
  "/internal/backfill-apollo-audience-pointers",
  requireApiKey,
  async (req, res) => {
    const parsedQuery = BackfillApolloPointersQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.message });
      return;
    }
    const dryRun = parsedQuery.data.dryRun === "true";
    const asyncMode = parsedQuery.data.async === "true";

    const rows = await db
      .select()
      .from(audiences)
      .where(
        and(
          eq(audiences.provider, "apollo"),
          isNull(audiences.apolloAudienceId),
          ne(audiences.status, "deprecated")
        )
      );

    const scanned = rows.length;

    if (dryRun) {
      const sample = rows
        .slice(0, APOLLO_POINTER_SAMPLE_LIMIT)
        .map((r) => ({ id: r.id, name: r.name }));
      console.log(`[human-service] backfill_apollo_ptr.dry_run scanned=${scanned}`);
      res.json({
        dryRun: true,
        scanned,
        wouldBackfill: scanned,
        backfilled: [],
        failed: [],
        sample,
      });
      return;
    }

    if (asyncMode) {
      res.status(202).json({
        dryRun: false,
        started: true,
        scanned,
        wouldBackfill: scanned,
        backfilled: [],
        failed: [],
        sample: [],
      });
      void runApolloPointerBackfill(rows)
        .then(({ backfilled, failed }) =>
          console.log(
            `[human-service] backfill_apollo_ptr.run_async scanned=${scanned} backfilled=${backfilled.length} failed=${failed.length}`
          )
        )
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[human-service] backfill_apollo_ptr.run_async_aborted ${msg}`);
        });
      return;
    }

    try {
      const { backfilled, failed } = await runApolloPointerBackfill(rows);
      console.log(
        `[human-service] backfill_apollo_ptr.run scanned=${scanned} backfilled=${backfilled.length} failed=${failed.length}`
      );
      res.json({
        dryRun: false,
        scanned,
        wouldBackfill: scanned,
        backfilled,
        failed,
        sample: [],
      });
    } catch (err) {
      // Systemic apollo outage / missing config -> fail loud (502). Already-pointed
      // rows persist; a re-run resumes (only pointer-less rows remain).
      if (err instanceof MigrationAborted) {
        res.status(502).json({ error: err.message, failed: err.failed });
        return;
      }
      throw err;
    }
  }
);

export default router;
