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

The CRM `/orgs/lists/*` endpoints use `requireOrgIdOnly`: only `x-org-id` is
required. `x-user-id` is parsed when present and populates
`created_by_user_id` / `added_by_user_id`. `x-run-id` is parsed when present
for run-tracking parent linkage.

The legacy `/humans/*` and `/humans/{id}/methodology` endpoints use the
older `requireIdentity` middleware that requires all three of `x-org-id`,
`x-user-id`, `x-run-id`.

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
