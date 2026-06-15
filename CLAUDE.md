# human-service

Backend service that owns two distinct concerns:

1. **Human expert profiles** (legacy v0) — scrapes a person's online presence
   (websites, blog, LinkedIn, etc.) and caches an AI-extracted "methodology"
   (frameworks, tone of voice, persuasion style) used as writing context for
   AI content generation. Tables: `humans`, `human_methodologies`.

2. **CRM glue v1** — org-scoped curated lists of contacts (`lists`,
   `list_members`). Members reference contacts in other services (e.g.
   google-service People API resources) via `(source_service,
   source_resource_id)` string pointer. No FK across services.

3. **People gateway v1** — a provider-agnostic façade over `apollo-service`
   (rich search + enrich) and `apify-service` (verified-email waterfall).
   Callers hit `/orgs/people/*` to search people and resolve verified emails
   without caring which provider serves the request. Routes + normalizes; owns
   a **per-brand cross-provider suppression** log (tables `lead_serves` bronze +
   `brand_suppressions` silver — only the gateway sees both providers' emissions
   for a brand, so the "already served" truth lives here). Declares **no cost**
   (apollo/apify own the paid call); forwards `x-run-id` for downstream tracing.
   See below.

Stack: Express + Drizzle (Postgres) + Zod + zod-to-openapi. Deployed on
Railway via `Dockerfile`. Migrations in `drizzle/` apply on cold start.

## Route map

| Tier | Route | Auth | Purpose |
|------|-------|------|---------|
| Public | `GET /health` | none | Health check |
| Public | `GET /openapi.json` | none | Generated spec |
| Org-scoped (legacy) | `POST /humans` | apiKey + identity (org+user+run) | Upsert a human profile |
| Org-scoped (legacy) | `GET /humans` | apiKey + identity | List humans for an org |
| Org-scoped (legacy) | `GET /humans/{id}` | apiKey + identity | Get a human by id |
| Org-scoped (legacy) | `GET /humans/{id}/methodology` | apiKey + identity | Get cached methodology |
| Org-scoped (legacy) | `POST /humans/{id}/extract` | apiKey + identity | Trigger scrape + AI extraction |
| Internal | `POST /internal/transfer-brand` | apiKey | Move solo-brand methodology rows between orgs |
| Org-scoped (CRM v1) | `POST /orgs/lists` | apiKey + `x-org-id` | Create a CRM list |
| Org-scoped (CRM v1) | `GET /orgs/lists` | apiKey + `x-org-id` | List CRM lists (paginated, optional `brandId` filter) |
| Org-scoped (CRM v1) | `GET /orgs/lists/{id}` | apiKey + `x-org-id` | Get a CRM list |
| Org-scoped (CRM v1) | `PATCH /orgs/lists/{id}` | apiKey + `x-org-id` | Update name / description / brand |
| Org-scoped (CRM v1) | `DELETE /orgs/lists/{id}` | apiKey + `x-org-id` | Delete (cascades members) |
| Org-scoped (CRM v1) | `GET /orgs/lists/{id}/members` | apiKey + `x-org-id` | List members (paginated) |
| Org-scoped (CRM v1) | `POST /orgs/lists/{id}/members` | apiKey + `x-org-id` | Bulk add (idempotent on `(list_id, source_service, source_resource_id)`) |
| Org-scoped (CRM v1) | `DELETE /orgs/lists/{id}/members` | apiKey + `x-org-id` | Bulk remove |
| Org-scoped (People v1) | `POST /orgs/people/search` | apiKey + `x-org-id` + `x-user-id` | Search people via apollo/apify, normalized |
| Org-scoped (People v1) | `POST /orgs/people/resolve-email` | apiKey + `x-org-id` + `x-user-id` | Reveal a verified email — apollo by `providerPersonId` (`/enrich`, billed) or name+domain (`/match`); apify by name+domain |
| Org-scoped (People v1) | `POST /orgs/people/search/dry-run` | apiKey + `x-org-id` + `x-user-id` | Count matches, free (apollo only in v1) |
| Org-scoped (People v1) | `GET /orgs/people/filters-prompt` | apiKey + `x-org-id` + `x-user-id` | LLM filter-shape prompt (apollo only in v1) |

The CRM `/orgs/lists/*` endpoints use `requireOrgIdOnly`: only `x-org-id` is
required. `x-user-id` is parsed when present and populates
`created_by_user_id` / `added_by_user_id`. `x-run-id` is parsed when present
for run-tracking parent linkage.

The legacy `/humans/*` and `/humans/{id}/methodology` endpoints use the
older `requireIdentity` middleware that requires all three of `x-org-id`,
`x-user-id`, `x-run-id`.

## People gateway (v1) — `/orgs/people/*`

Provider-agnostic façade. `src/services/people-providers.ts` does the routing,
filter mapping, and response normalization; `src/routes/people.ts` is the thin
HTTP layer (`requireOrgAndUser` — `x-org-id` + `x-user-id` required, `x-run-id`
optional). Unlike the CRM `/orgs/lists/*` routes (which use `requireOrgIdOnly`),
the people gateway needs `x-user-id` because apollo/apify require it for key
resolution / attribution — accepting a request without it would only produce a
confusing downstream 502.

- **Routing**: explicit `provider: "apollo" | "apify"` wins; else
  `need: "verified_email"` → apify; else default **apollo** (richest, fully
  ready). `resolve-email` **also defaults to apollo** (same provider as search;
  the reveal follows the provider that searched — a `providerPersonId` is
  provider-specific, so we never cross providers).
- **Reveal (`resolve-email`) is generic — input mirrors the search output.** The
  neutral `Person` from search carries its own `provider` + handle; hand it back
  to reveal:
  - **apollo + `providerPersonId`** → `/enrich` (THE billed path: 1
    `apollo-credit` per verified email). Apollo search returns only a teaser
    (first name + person id) and **masks last name + domain**, so identity
    `/match` can't be satisfied from a search hit — enrich-by-id is the reveal
    that works for an apollo-sourced lead.
  - apollo + name+domain (no person id) → `/match` (fallback, also billed).
  - **apify + name+domain** → `/resolve` (waterfall). apify has no person-id
    enrich → a `providerPersonId`-only request fails loud (501), never silently
    crosses mechanisms.
  - Request requires `providerPersonId` OR (`firstName` + `lastName` + `domain`)
    — Zod refine, 400 otherwise.
- **Neutral `Person` shape**: field names mirror lead-service `FullLead` so a
  future Sales Lead Service mapping is trivial — but the type is **owned here**,
  never imported cross-repo.
- **Pagination**: apollo keeps its server-managed cursor (keyed by org +
  `x-campaign-id`); human-service forwards next-page calls (empty body advances
  the cursor). apify is one-shot (`limit`, default 100) → `done: true`.
- **Fail loud**: a provider non-2xx / network error → thrown `ProviderError` →
  **502** (never a silent fallback). `ProviderConfigError` (missing env) → 502.
- **Cold-start retry**: apollo/apify are Neon-backed siblings; the first call
  after their idle scale-to-zero rejects with `fetch failed` (cause
  ECONNRESET/ETIMEDOUT). `fetchWithConnectRetry` retries the **connect phase
  only** (thrown rejection, never a completed HTTP response) with 250/500/1000ms
  backoff — write-safe because the request never reached the server. See
  CLAUDE.md global "second surface" note.
- **apify parity** (apify-service#6, shipped): `dry-run` → apify `POST
  /search/count`; `filters-prompt` → apify `GET /search/filters-prompt`;
  `search` consumes apify `totalMatched`/`hasMore`/`nextOffset` + accepts
  `offset`. apify pagination/total are **pipelinelabs-only** signals
  (microworlds contributes page 1 only) — surfaced as a provider-specific
  cursor (`nextOffset`), NOT a cross-source-exact total. Rich filters
  (`companySizes`, `revenueRanges`, `fundingStages`, `technologies`) map to
  apify verbatim; `revenueRanges`/`technologies` also map to apollo.
- **Per-brand cross-provider suppression** (human-service#36): every serve (a
  lead handed back with a verified email — apify at `/search`, apollo at
  `resolve-email`) is logged per **atomic brand** for a **3-month** window.
  Later requests for that brand exclude already-served leads, **across
  providers**. The "before paying" mechanism rides each provider's billing
  asymmetry:
  - **apollo** search is FREE (only enrich bills) → drop already-served teasers
    in-gateway (match on `linkedin_url_norm` OR `provider_person_id`) BEFORE
    revealing the email. A brand-saturated audience pages the free cursor a
    bounded number of times (`APOLLO_MAX_SATURATION_PAGES`) then returns a
    truthful `done` — producer-side saturation stop, no consumer heuristic.
  - **apify** BILLS per returned lead → can't post-filter (pay-then-drop). The
    brand's exclude-set (`excludeEmails` + `excludeLinkedinUrls`) is **pushed
    down** to apify `/search` so the actor never returns/bills a served lead and
    stops when the fresh pool is dry. **Depends on apify-service accepting the
    exclude-set** (apify-service#18 engine) — until it ships, the apify path
    still records serves (feeding apollo cross-exclusion) but won't self-exclude.
  - **resolve-email block**: the residual no-linkedin cross-provider edge (an
    apify-served lead with no linkedin slips the apollo teaser filter and gets
    enriched) is caught at `resolve-email` — an `email_norm` suppression hit
    returns `person:null` so it's not re-served (credit already spent).
  - **Layering (B/S/G)**: bronze `lead_serves` (append-only, audit, silver
    rebuildable) → silver `brand_suppressions` (canonical per `(org, brand,
    email_norm)`, the only table the read paths query, promoted inline at serve
    time). Identity keys: `email_norm` canonical; `linkedin_url_norm` is the
    cross-provider key available pre-pay on both providers. Window enforced on
    read via `last_served_at`. No gold table (a view if a consumer needs counts).
    `src/services/suppression.ts` owns it; `org_id`/`brand_id` uuid,
    `campaign_id`/`run_id` text (audit-only).
- **No cost declaration here** — apollo/apify own the paid call; human-service
  only forwards `x-run-id`.
- **Env vars**: `APOLLO_SERVICE_URL`, `APOLLO_SERVICE_API_KEY`,
  `APIFY_SERVICE_URL`, `APIFY_SERVICE_API_KEY`. Read at call time (not boot) so
  a missing var fails the request loudly rather than crash-looping boot.

## Org isolation

Every `/orgs/*` query MUST filter by `WHERE org_id = $orgId`. List ownership
is checked before any member operation: a list belonging to another org
returns 404, never 403, to avoid leaking existence.

## Identity headers — `org_id` typing note

- **`lists` and `list_members`**: `org_id uuid NOT NULL` (matches platform
  standard for new tables — internal UUIDs from client-service).
- **`humans` and `human_methodologies`** (legacy): `org_id text` — predates
  the internal-UUID convention. Do not migrate without coordinating with
  every caller.
- **`lead_serves` and `brand_suppressions`** (people gateway): `org_id` +
  `brand_id` uuid (new-table convention); `campaign_id` / `run_id` text
  (audit-only forwarded headers, not guaranteed uuid).

The same request can hit both column families because the value passed in
`x-org-id` is text-coercible-to-uuid in practice. New tables use `uuid`.

## Data layering

This service owns **CRM-glue** tables, not ingested data. Layering applies
differently to each concern:

### Human profiles (v0)

- `humans` is a primary entity with cached scraped fields. Not pure bronze
  (transformations applied on insert from the upsert endpoint).
- `human_methodologies` is a derived AI-extracted projection cached with
  TTL via `expiresAt`. Refreshed on `POST /humans/{id}/extract`.

### CRM lists (v1, current)

- `lists` and `list_members` are **CRM glue**, not ingested data. They have
  no bronze/silver layering because the user creates them by hand in the
  dashboard — there is no upstream source of truth to mirror.
- `list_members.source_resource_id` is a **string pointer** into another
  service's bronze layer (today: google-service `people/c123...`
  resource ids). No FK across service boundaries.
- `list_members.human_id` is nullable and reserved for v2 — see below.

### CRM v2 (future, when 2nd contact source lands)

When a second contact source ships (LinkedIn, Apollo, manual entry, …),
deduplication becomes necessary. Plan:

1. Introduce a silver `humans` table inside this service (or a dedicated
   contact-service if scope warrants), keyed on `lower(primary_email)` per
   org.
2. A scheduled batch job reads bronze rows from each contact source
   (google-service `google_contacts`, future LinkedIn / Apollo bronze
   tables, manual-entry table) and upserts canonical `humans` rows with
   source attribution.
3. Backfill `list_members.human_id` for every existing row whose
   `(source_service, source_resource_id)` resolves to a silver `humans`
   row.
4. Newly added members run the resolver inline at insert time.
5. Manual user edits live in a `humans_overrides` table and win over
   derived fields on every rebuild.

UI behaviour after v2 lands:

- Prefer `human_id` when present (canonical contact view).
- Fall back to displaying the source pointer when `human_id` is null
  (orphaned bronze — silver promotion not yet run for this resource).

The current v1 `humans` and `human_methodologies` tables are **not** the
silver layer described above. They will likely be renamed when v2 lands —
but only after migrating every caller.

## Local development

```bash
cp .env.example .env
npm install
npm run db:push            # Creates tables locally
npm run dev                # Starts on http://localhost:3000
npm test                   # Runs vitest against postgresql://test:test@localhost:5432/human_test
```

To re-generate the OpenAPI spec after editing `src/schemas.ts`:

```bash
npm run generate:openapi
```

**Migrations are hand-authored, not `drizzle-kit generate`d.** `drizzle/meta/`
keeps only `0000_snapshot.json` (intermediate snapshots were never committed),
so `drizzle-kit generate` mis-diffs — it prompts to "rename" EXISTING tables
(e.g. `humans` from `human_profiles`) and would emit a destructive migration.
For a new table: hand-write `drizzle/NNNN_*.sql` (idempotent — `CREATE TABLE IF
NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) following `0007`/`0008`, and append a
matching entry to `drizzle/meta/_journal.json` with a `when` greater than every
existing entry (the runtime migrator only checks `when`, ignores the SQL hash).
`drizzle-kit migrate` applies them on boot + in CI.

## Run tracking

Run tracking is wired through `src/services/runs.ts` for the legacy
`/humans/*` endpoints. The CRM `/orgs/lists/*` endpoints currently rely on
the caller's `x-run-id` for downstream tracing only — they don't create
their own runs because list CRUD is short, idempotent, and free.

## Cold-start instrumentation

`src/instrumentation.ts` registers `HUMAN_SERVICE_API_KEY` as a platform key
in key-service so other services can resolve it without configuring local
env vars. Idempotent and safe to call on every boot. Skipped silently in
local dev / tests when `KEY_SERVICE_URL` is not set.
