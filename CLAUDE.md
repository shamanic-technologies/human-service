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
| Internal | `POST /internal/remap-audience-filters` | apiKey | One-time data fix: translate already-backfilled audiences' filters from legacy persona vocab → canonical `PeopleSearchFilters` vocab, in place (idempotent, `?dryRun=true`, reversible) |
| Internal | `POST /internal/backfill-audience-descriptions` | apiKey | One-time data fix: generate a per-audience one-sentence `description` (from name + filters via chat-service platform LLM) for every audience whose `description IS NULL` — pre-#82 rows (idempotent, `?dryRun=true`) |
| Internal | `POST /internal/migrate-apify-audiences-to-apollo` | apiKey | One-time data fix (APOLLO-ONLY cutover): for every non-deprecated `provider='apify'` audience, build an equivalent apollo audience via apollo-service (`POST /audiences/suggest-from-segment`), store the pointer + faithful filters, create a new apollo audience mirroring the source status, and mark the apify one `deprecated` (idempotent, `?dryRun=true`, reversible) |
| Internal | `POST /internal/backfill-canonical-audience-links` | apiKey | One-time data fix: link each EXISTING deprecated provider-variant audience (`<base> [Apify]`) to its active same-`(org,brand)`-base-name canonical sibling (`audiences.canonical_audience_id`), so membership/stats reads resolve a deprecated match to the clean active audience. Pre-link rows from the apify→apollo migration (which now sets the link going forward). Skips 0/ambiguous-sibling rows (fail loud, never guess). Idempotent, `?dryRun=true`, reversible |
| Internal | `POST /internal/backfill-apollo-audience-pointers` | apiKey | One-time data fix ("one filter vocabulary" Wave 2): for every `provider='apollo'` audience lacking `apollo_audience_id`, build a faithful Apollo audience via apollo-service `POST /audiences/suggest-from-segment` (from the row's name + description), then store the **pointer** + cached faithful filters (replacing the old lossy neutral blob) + count. Idempotent (scoped to `apollo_audience_id IS NULL`), `?dryRun=true`, `?async=true`, reversible |
| Internal | `POST /internal/audiences/resolve` | apiKey | **Bulk server-to-server audience resolver** for lead-service (#166): body `{orgId, brandId, audienceIds?, emails?}` → `{byAudienceId, byEmail}` maps of `{id,name,avatarUrl}` \| null. Brand-correct + active-preferred (deprecated→canonical), keyed by audienceId AND/OR email (historical coverage). Dedicated **25 MB** body parser (mounts before the global 100 KB json) — NO browser 413 cap. See below. |
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
| Org-scoped (Audiences v1) | `POST /orgs/audiences/suggest` | apiKey + `x-org-id` + `x-user-id` | NL → **persisted** candidate audiences (one per segment, best provider only), returns `audienceId`s at status `suggested` (inactive) |
| Org-scoped (Audiences v1) | `POST /orgs/audiences` | apiKey + `x-org-id` | Create an audience (saved filter-set + optional count snapshot + provider) |
| Org-scoped (Audiences v1) | `GET /orgs/audiences` | apiKey + `x-org-id` | List audiences (paginated, optional `brandId` filter) — each item also carries server-computed `sizeCount` / `availableToContactCount` / `availableToContactPct` (Size / Remaining, see below) |
| Org-scoped (Audiences v1) | `GET /orgs/audiences/{id}` | apiKey + `x-org-id` | Get an audience |
| Org-scoped (Audiences v1) | `PATCH /orgs/audiences/{id}` | apiKey + `x-org-id` | Update metadata (name / nlPrompt only) — immutable otherwise |
| Org-scoped (Audiences v1) | `PATCH /orgs/audiences/{id}/status` | apiKey + `x-org-id` | Change status (active / paused / archived) — mutates only status |
| Org-scoped (Audiences v1) | `DELETE /orgs/audiences/{id}` | apiKey + `x-org-id` | Hard delete (cascades members) — archive is a soft state, not delete |
| Org-scoped (Audiences v1) | `POST /orgs/audiences/{id}/refresh-count` | apiKey + `x-org-id` + `x-user-id` | Re-snapshot apollo + apify counts via free dry-run |
| Org-scoped (Audiences v1) | `POST /orgs/audiences/{id}/serve-next` | apiKey + `x-org-id` + `x-user-id` | Serve the NEXT unserved person of the audience (real provider match on its stored filters; records served; never repeats; clean exhausted signal) |
| Org-scoped (Audiences v1) | `POST /orgs/audiences/{id}/avatar` | apiKey + `x-org-id` + `x-user-id` | (Re)generate the audience avatar via chat-service; persisted as a `data:` URI on `avatarUrl` |
| Org-scoped (Audiences v1) | `GET /orgs/audiences/{id}/members` | apiKey + `x-org-id` | List canonical people in the audience (paginated) |
| Org-scoped (Audiences v1) | `POST /orgs/audiences/stats` | apiKey + `x-org-id` | Per-audience membership stats for a list of emails / personIds |

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

- **APOLLO-ONLY (2026-06).** apify is no longer **auto-selected**: `resolveProvider`
  default + the former `need: "verified_email"` → apify branch (commented) now
  resolve to **apollo**, and `SUGGEST_PROVIDERS = ["apollo"]` so `/suggest` never
  creates apify audiences. An **explicit** `provider: "apify"` is STILL honored
  (existing apify audiences' serve-next), and all apify functions remain compiled
  but unreachable-by-default (inert, not deleted — re-enable by restoring those two
  lines). Existing apify audiences were migrated to apollo equivalents via
  `POST /internal/migrate-apify-audiences-to-apollo` (see Audiences below).
- **Routing**: explicit `provider: "apollo" | "apify"` wins; else
  ~~`need: "verified_email"` → apify;~~ default **apollo** (richest, fully
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
  the cursor). apify is offset-based (`limit` + `offset`).
- **apify billing asymmetry — default `limit: 1` (strict minimum).** apollo
  search is a FREE teaser (masked email + person id); the verified email is
  revealed one-by-one, billed, via `resolve-email`. apify has NO free teaser —
  every `/search` hit carries a verified email and is **billed per returned
  lead**, and no endpoint returns names without buying the email (`/search/count`
  yields only a count). So the gateway can't replicate apollo's free-list-then-
  reveal pattern on apify; instead it takes the **strict minimum** — apify
  `limit` defaults to **1**, not a batch. A caller that consciously wants N leads
  passes an explicit `limit` and pays for N. The dry-run (`/search/count`, free)
  is the way to size a result set before spending. apollo ignores `limit`
  (cursor-based).
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
    revealing the email. A brand-saturated stretch is **walked through** — the
    gateway keeps paging the free teaser cursor until a page yields a fresh lead
    OR Apollo reports true pool exhaustion (`data.done`). There is **NO
    artificial page cap**: the upward `done` is HONEST (real depletion only), so
    serve-next never false-exhausts on a region the brand already contacted. (A
    fixed 5-page `APOLLO_MAX_SATURATION_PAGES` budget previously fabricated `done`
    here and auto-stopped live campaigns with leads still left in the pool —
    removed. Apollo's cursor guarantees termination at `totalPages`; the walk is
    bounded by the free pool, costs $0, and the cursor advances across calls.)
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

## Audiences (v1) — `/orgs/audiences/*`

A provider-agnostic **audience** concept layered on the people gateway. An
audience is a **saved persona/ICP filter-set** + a per-provider headcount; as
the gateway serves people under an audience it accrues a **canonical, deduped
membership**. Then `/orgs/audiences/stats` answers "which audiences are these
emails/people in?". `src/services/audiences.ts` owns the engine;
`src/routes/audiences.ts` is the thin HTTP layer.

- **"One filter vocabulary" Wave 2 — apollo audiences are a POINTER, not a
  human-built filter set.** human-service NO LONGER holds Apollo's filter
  vocabulary. For an apollo audience the row stores `apollo_audience_id` (migration
  `0016`) — a pointer to a **faithful Apollo audience owned by apollo-service**,
  which runs the NL→faithful-Apollo-filters agentic refine loop internally and owns
  its filter shape + count. The `filters` jsonb column is KEPT but, for apollo rows,
  now **caches the OPAQUE faithful Apollo filter object** (verbatim from
  apollo-service) — so serve-next forwards it to apollo `/search` with NO
  neutral→apollo remap, and there is zero Apollo filter-building code here. The
  in-human-service Layer-2 loop + apolloDslToNeutral mapper (the interim v0.20.8
  approach) are DELETED. human-service stays the NEUTRAL cross-provider layer: its
  silver/gold (canonical `people`, membership, `/stats`, the `Person` output) +
  outward contracts are unchanged + byte-stable. `src/lib/apollo-audiences.ts` is
  the client (`suggestApolloAudience` / `getApolloAudience` / `apolloAudienceDryRun`
  → apollo-service `POST /audiences/suggest-from-segment`, `GET /audiences/{id}`,
  `POST /audiences/{id}/dry-run`), reusing the gateway's single apollo HTTP layer
  (`apolloPost`/`apolloGet`, connect-retry, fail-loud `ProviderError`). apify
  (legacy/inert) audiences are UNCHANGED — they still store their own neutral
  filters; only the apollo path moved to the pointer model.

- **Naming follows CDP/CRM canon, deliberately** (Segment / Salesforce CDP /
  Adobe AEP / HubSpot, + Kimball/medallion): **`audience`** = a saved filter-set
  whose membership is computed dynamically ("dynamic audience"). NOT `persona`
  (in CDP canon persona is the trait-assignment layer ABOVE audiences) and NOT
  `database_search` (names the mechanism, not the thing). The canonical person
  entity is **`people`** because the legacy `humans` table is expert-profiles (a
  different concept) — the API exposes its id as `personId`. The many-to-many is
  the **Kimball bridge** `audience_members` with effective dates (`joined_at` /
  `last_served_at`) for point-in-time membership.
- **Counts: by pointer (apollo) or dual dry-run (legacy).** `apollo_count` +
  `apify_count` are a snapshot. `POST /{id}/refresh-count` re-counts FOR FREE:
  an apollo audience (has `apollo_audience_id`) re-counts **by pointer** via
  apollo-service `POST /audiences/{id}/dry-run` (sets `apollo_count`; its
  `apify_count` is not meaningful and is left as-is); a legacy/neutral audience
  (apify, or a pre-Wave-2 row with no pointer) keeps the dual free dry-run on its
  stored NEUTRAL filters (apollo `/search/dry-run` + apify `/search/count`).
  `refreshAudienceCounts(audience, identity)` owns the branch. **No cost** —
  dry-run is the free count path; refresh-count needs `x-user-id` (apollo/apify
  key resolution), the CRUD routes use `requireOrgIdOnly`.
- **Membership = PROVENANCE, not local matching.** A person joins an audience
  iff a serve made under that audience returned them. The caller passes
  `audienceId` on `/orgs/people/search` or `/resolve-email`; the route validates
  it belongs to the org (404 before any provider spend) and, after the result,
  tags every returned person (apollo free teasers + apify billed hits alike) as
  a member. We **never** re-implement provider filter-matching locally —
  provenance matches provider semantics exactly. One person accrues many
  audiences over time as different audiences' searches surface them. **Eager
  cross-audience matching ("this person also fits audience Y before Y is
  queried") is deliberately deferred** — it would require local predicate eval
  on structured filters only, tagged `confidence:'locally_inferred'` (the
  `confidence` column exists for it). v1 only writes `provider_confirmed`.
- **Dedup (multi-source).** `resolvePersonId` (in a transaction) matches an
  incoming served contact to a canonical `people` row by `email_norm` (canonical)
  → `linkedin_url_norm` → `apollo_person_id`/`apify_person_id`, merging
  newly-learned fields (coalesce). So an apollo teaser (no email, has person id +
  linkedin) and its later apify reveal (same linkedin, now with email) collapse
  to ONE person. `email_norm` non-partial unique on `(org_id, email_norm)`
  (nullable, NULLs distinct, ON CONFLICT-safe) guards the email race.
- **Layering (B/S/G).** 🥉 bronze `lead_serves` gains an audit `audience_id`
  (the serve's audience). 🥈 silver = `people` (canonical dimension) + `audiences`
  + `audience_members` (bridge). Gold = `/orgs/audiences/stats` /
  `/{id}/members` rollups (views/queries, no table). `org_id`/`brand_id` uuid;
  `source` text (provider).
- **No cost declaration here** either — counting rides the providers' free
  dry-run; the billed reveal still belongs to apollo/apify.
- **Canonical resolution (deprecated provider-variant → live replacement).** The
  apify→apollo migration deprecates `<base> [Apify]` and creates an active apollo
  twin `<base>`, but leaves the apify row's `audience_members` attached to the
  DEPRECATED row. Without a link, any consumer that resolves a lead's audience
  from membership lands on the deprecated variant — retired `[Apify]` name + no
  avatar (the dashboard only loads avatars for non-deprecated audiences). So
  `audiences.canonical_audience_id` (migration `0015`, self-FK `ON DELETE SET
  NULL`, nullable) points a deprecated variant at its active replacement.
  `computeStats` (`POST /orgs/audiences/stats`) LEFT-JOINs the canonical row and,
  when a matched audience is `deprecated` AND has a canonical link, returns the
  **canonical** id + clean name — **de-duped per person AND per audience on the
  RESOLVED id** (a person on both the deprecated and active variant surfaces the
  canonical audience once; `matchedCount` is a distinct-person count, not a
  membership-row count). Provenance is preserved: `audience_members` are NOT
  re-pointed, the deprecated row + its members stay intact — only the READ
  resolves. The link is set TWO ways: (1) going forward, `migrateApifyAudience
  ToApollo` sets it in the same txn as the deprecate+insert; (2) for pre-existing
  deprecated rows, the `POST /internal/backfill-canonical-audience-links` sweep.
  The join key is `(org_id, brand_id, lower(base_name))` where `base_name` is the
  deprecated name minus its trailing ` [Provider]` suffix; the unique index
  `idx_audiences_org_brand_lower_name` guarantees ≤1 non-deprecated sibling per
  `(org, brand)`, so the match is unambiguous (e.g. two same-base "Solo Founders
  >$100k Revenue" rows in DIFFERENT orgs do not collide — org-scoping separates
  them). FAIL LOUD on ambiguity: a deprecated row with no variant suffix, 0
  siblings, or (defensively) >1 sibling is SKIPPED + logged, never guessed.

### List contactability (Size / Remaining) — `GET /orgs/audiences`

Every item in the `GET /orgs/audiences` list carries three ready numeric fields
so the dashboard Audiences table renders "Size" / "Remaining" straight from the
wire (NEVER client-computed). `computeAudienceContactability` in
`src/services/audiences.ts` owns the engine; the list route merges its result
onto each `serializeAudience` row. **Only the LIST endpoint** carries them
(`AudienceListItemSchema` extends `AudienceSchema`); the single-audience GET /
CRUD responses stay the plain `AudienceSchema`.

- **`sizeCount`** — total contactable pool = the committed provider's count
  snapshot (`provider='apify'` → `apifyCount`, else `apolloCount`). A
  never-counted row (null) is `0` (pool unknown = empty; the one explicit guard,
  not a swallowed error). Provider pool members are NOT enumerable locally, so
  this is the provider's own snapshot, not a local row count.
- **`availableToContactCount`** — pool members NOT suppressed within the 3-month
  re-contact window = `sizeCount − (members served within window)`. Uses the SAME
  per-brand cross-provider suppression the serve path enforces
  (`brand_suppressions` + the shared `windowCutoff` exported from
  `suppression.ts`), intersected with the audience's provenance membership
  (`audience_members` → `people` → `brand_suppressions`, matched on `email_norm`
  OR `linkedin_url_norm`, `last_served_at > now() - interval '3 months'`,
  brand-wide across providers). Never-served pool members are all available; a
  member last served >3 months ago is contactable again; a member served within
  the window is subtracted. Clamped `≥ 0` (a stale snapshot can report fewer in
  the pool than served).
- **`availableToContactPct`** — `round(availableToContactCount / sizeCount *
  100)`, integer `0..100`; `0` when `sizeCount` is `0` (the only divide-by-zero
  guard). Denominator is EXACTLY `sizeCount` so Size and Remaining's % never
  disagree for the same row.
- **No cost** — pure DB read; no downstream calls. One grouped query per list
  page (not N+1). The window lives here by design (per-brand, cross-provider
  suppression is human-service's job) — never moved to another service.

### Internal bulk audience resolver — `POST /internal/audiences/resolve`

Server-to-server (service-auth `x-api-key`, no browser body cap) resolution of a
large batch of leads to their brand-correct **active audience card**
`{id, name, avatarUrl}`, keyed by `audienceId` AND/OR `email`. Powers
lead-service#346 (dashboard Leads "Audience" column): lead-service fans out a
whole brand's leads (thousands of emails) in ONE call to attach the audience onto
each lead server-side. `src/routes/internal-audiences.ts` is the thin layer;
`resolveAudiencesForBrand` in `src/services/audiences.ts` owns the engine.

- **Why not `/orgs/audiences/stats`?** That route is org+email scoped
  (cross-brand, no status/avatar) and rides the global **100 KB** `express.json`
  cap — the dashboard's ~7.7k-email fan-out 413s there. This resolver mounts
  **before** the global parser with its OWN **25 MB** `express.json` (body-parser
  sets `req._body`, so the global parser no-ops on it); org-scoped routes keep the
  100 KB browser guard. `computeStats` is left untouched (the browser `/stats`
  path still serves the small membership-inspector use case).
- **Brand-correct (AC2)** — only audiences of the body's `brandId` are ever
  returned; a foreign-brand `audienceId` or a foreign-brand membership resolves to
  `null`. An org spans brands, so this prevents attributing a foreign-brand
  audience.
- **Active-preferred (AC1)** — each membership's audience is resolved through the
  same deprecated→canonical link `computeStats` uses (so `/stats` and the resolver
  agree). The **by-email** path then picks the best-status membership per person:
  `active` > `paused` > `archived`; `suggested` (never-chosen) and unlinked
  `deprecated` (`[Provider]` variant with no live twin) are **excluded** — we
  surface a live card, never a retired name. Tiebreak: most-recent
  `last_served_at`. The **by-audienceId** path resolves a directly-tagged id to
  its effective (canonical) card, `null` only if foreign-brand / unknown / retired.
- **Historical coverage (AC3)** — the by-email key on `people.email_norm` covers
  leads that predate `audience_id` tagging (lead-service never tagged them). **No
  backfill / new state** — `audience_members` is already promoted from
  `lead_serves` at serve time (prod gap ≈ 16/5668 rows = dedup noise), so EMAIL is
  the historical key, not a sweep. A lead human-service **never served** (served
  pre-gateway via the old direct lead-service path) resolves to `null` — honest, we
  cannot invent an audience we never assigned (never mock absent data).
- **Contract**: body `{ orgId (lax uuid — org ids predate v4), brandId (strict),
  audienceIds?: uuid[], emails?: string[] }`, at least one of the two lists (400
  otherwise). Response `{ byAudienceId: Record<id, card|null>, byEmail:
  Record<rawEmail, card|null> }` — `byEmail` is keyed by the **raw** email as sent
  (normalization is internal). **No cost** (pure DB read); no downstream calls.
  Fail loud on a DB error (propagates).

### Serve-next (lead primitive) — `POST /orgs/audiences/{id}/serve-next`

The per-iteration lead primitive the new runtime calls: lead-service asks
features-service for the most-relevant audienceId for a brand, then asks
human-service here for the NEXT person of that audience. `requireOrgAndUser`
(`x-user-id` needed for apollo/apify key resolution). `serveNextPerson` in
`src/services/audiences.ts` owns it; `src/routes/audiences.ts` is the thin layer.

- **It's a thin WRAPPER over the existing people-gateway, not new matching.** It
  loads the audience (404 if missing/foreign), searches with the audience's
  **STORED `filters` via its committed `provider`**, brand-scoped to
  **`audience.brandId`** (the route forces `identity.brandIds = [audience.brandId]`
  — never a header), records the serve, tags `audience_members`, and returns
  `{ status, person }`. For an **apollo** audience the stored filters are ALREADY
  Apollo's faithful shape (sourced from apollo-service), so they are forwarded
  **VERBATIM** as the apollo search params (`peopleSearch({ apolloSearchParams })`,
  no neutral→apollo remap); for an **apify** audience the stored neutral filters are
  mapped to apify as before. The suppression / reveal / saturation machinery is
  UNCHANGED and still operates on the neutral `Person` output.
- **No-repeat = the EXISTING per-brand cross-provider suppression**, reused, not a
  new per-audience exclusion table. Once served for the brand (under ANY audience),
  a person is excluded brand-wide within the 3-month window — a strictly stronger
  guarantee than "never twice for this audience". Membership tagging is provenance
  only. (The 3-mo window lapsing is the existing designed semantic; not a new
  forever-exclusion.)
- **Per provider**: apify → `peopleSearch(limit 1)` (exclude-set pushed down, hit
  is billed + recorded by the gateway) → that hit, or exhausted. apollo → drain a
  **buffered teaser page** ONE per call (migration `0017` `audience_teaser_buffer`,
  `src/services/teaser-buffer.ts`): each apollo `/search/next` returns up to 100
  free teasers AND advances apollo's forward-only cursor a whole page, but
  serve-next reveals only ONE lead per call — so a fetched page is BUFFERED and
  popped one teaser per call (`popTeaser`, atomic `DELETE … RETURNING` +
  `FOR UPDATE SKIP LOCKED`), and apollo's cursor only RE-advances when the buffer
  is empty (`peopleSearch` refill). Without this the other ~99 teasers/page were
  discarded and the cursor moved on for good, capping an apollo audience at
  **~1 served lead per page (~1% of its verified pool)** — fixed v0.25.0. Each
  popped teaser is re-checked against suppression PRE-PAY (it may have been served
  under another audience for the brand since buffering), then enriched one at a
  time (`resolveEmail` by `providerPersonId`, billed, recorded in
  `finalizeResolved`) until one reveals a non-suppressed person, then stop.
  Exhausted ONLY when the buffer is empty AND apollo returns no fresh teasers —
  no fabricated cap (apollo's honest `done` at totalPages bounds the walk; the
  2026-06-29 no-saturation-cap fix is preserved).
- **Exhaustion is explicit**: `{ status: "exhausted", person: null }` — never a
  silent empty. An audience with **no committed provider OR no stored filters**
  fails loud: `AudienceNotServableError` → **422** (can't serve without them).
- **No cost declared here** — apollo/apify own the billed reveal; the gateway only
  forwards `x-run-id` for downstream tracing.

### Avatar — `POST /orgs/audiences/{id}/avatar`

An audience carries a nullable **`avatarUrl`** (migration `0013`, `audiences.avatar_url
text`). The route (re)generates it by delegating image generation to
**chat-service `POST /orgs/images/generate`** (`src/lib/chat-client.ts`
`generateImage`) — the same delegation brand-service used for persona avatars.
`requireOrgAndUser` (`x-user-id` for chat-service key resolution).

- chat-service returns image **bytes** (`imageBase64` + `mimeType`), not a hosted
  URL; human-service stores them as a **self-contained `data:` URI** in
  `avatar_url` (no blob store — the row is fully self-describing). `GET
  /orgs/audiences/{id}` reflects it.
- Optional `prompt` body lets the dashboard AI-chat tool steer the image; omitted
  ⟹ the prompt is derived from the audience's own descriptors (`buildAvatarPrompt`).
- **Default style = flat-vector character, NOT a photoreal headshot.** The old
  "photorealistic headshot, neutral background" prompt collapsed every audience to
  the same interchangeable person-in-a-suit. `buildAvatarPrompt` now renders a
  **flat vector illustration** with role/industry-symbolising props on a **bold
  solid background**, and seeds three separable axes DETERMINISTICALLY from
  `audience.id` (FNV-1a `hashIndex`) — **background colour** (`pickAvatarPalette`,
  exported; the primary differentiation lever), **gender**, **age band** — so each
  audience keeps a stable look across regenerations AND the set spreads across
  colours/appearances (easy to tell apart). Descriptor source priority:
  `description` → `nlPrompt` → `name`. Prompt also requests `Square 1:1` + `no
  text`. **Known gap (separate chat-service fix):** chat-service owns
  `generationConfig` and does NOT yet set `aspectRatio:"1:1"`, so squareness rides
  on the prompt text only — image bytes can come back non-square until chat-service
  forces the aspect ratio.
- **No cost declared here** — chat-service OWNS the image-gen cost (it does the
  provision→authorize→execute→actualize against the org balance, exactly like
  `/complete` for `/suggest`); the invariant holds. Fail loud: a chat-service
  non-2xx / missing env → `ChatServiceError`/`ChatConfigError` → **502**.

### Status lifecycle + persona migration (Wave 2)

Audiences carry a **status lifecycle** mirroring brand-service persona
semantics, so every caller can treat an audience exactly like a persona
(filter by lifecycle, pause/resume/archive/restore). This is the human-service
half of the platform migration that makes audiences the SINGLE owner; a later
wave drops brand-service personas entirely + switches consumers'
(features-service / campaign-service / dashboard) reads.

- **`audiences.status`** = `suggested | active | paused | archived | deprecated`,
  default `active` (migration `0011`; column is free-text `text`, no DB CHECK —
  values enforced app-level in `AudienceStatusSchema`). `suggested` is the
  **inactive** default for rows created by `/suggest` (never live for the brand
  until flipped to `active`). An audience is **immutable except its status** —
  `PATCH /orgs/audiences/{id}` accepts only `name`/`nlPrompt` metadata; `brandId`
  and `filters` are rejected (`.strict()` → 400) because editing filters = a new
  audience (evidence attribution is keyed on the audience id). `PATCH
  /orgs/audiences/{id}/status` is the dedicated status-only mutator. The hard
  `DELETE` stays for true cleanup — **archive is a soft state, NOT a delete**.
- **`deprecated` is TERMINAL + admin-only** (the apify→apollo migration's retire
  state). It is NOT in the `ChangeAudienceStatusRequestSchema` user-settable enum
  (`PATCH /status {status:"deprecated"}` → **400**), and the status mutator's
  `WHERE` carries `ne(status, "deprecated")` so a deprecated row can't transition
  out (**404** — so a user can never reactivate a retired apify audience). `GET
  /orgs/audiences` **hides** `deprecated` by default (`ne(status,"deprecated")`
  unless `?status=deprecated` is passed explicitly), so the user dashboard stays
  clean with NO dashboard-side change. The migration also **renames** the retired
  apify row `"<name> [Apify]"` to free the unique `(org, brand, lower(name))` name
  for its apollo twin.
- **Name-unique per (org, brand)** (case-insensitive): unique index
  `idx_audiences_org_brand_lower_name` on `(org_id, brand_id, lower(name))`
  (migration `0012` widened it from brand-only so a name can repeat across orgs
  sharing a brand — the suggest flow keys proposals on org+brand+name). A
  duplicate-name create → 409.
- **One-time backfill (COMPLETE, endpoint REMOVED).** The persona→audience
  backfill `POST /internal/backfill-audiences-from-personas` and its
  brand-service persona-reader (`src/lib/brand-client.ts`,
  `GET /internal/personas`) ran once — 28 audiences copied into prod
  (id-preserving, tagged `source = 'brand_persona_backfill'`, filters mapped to
  canonical vocab) — then re-mapped to canonical filters. With brand-service
  personas being deleted platform-wide (Wave 2), both the endpoint and the
  client are now dead and were removed; the `BRAND_SERVICE_URL` /
  `BRAND_SERVICE_API_KEY` env vars they used are no longer read. The backfilled
  rows + their provenance tag remain live in `audiences`.
  - **Filter vocabulary is MAPPED, not copied verbatim** (still used by the
    re-map endpoint below). brand-service personas spoke the LEGACY persona vocab
    (`industry`, `jobTitles`, `location`, `employeeRange`, `seniority`,
    `department`, `fundingStage`, `revenueRange`, `keywords`, `technologies`);
    audiences (+ the people gateway) speak the canonical `PeopleSearchFilters`
    vocab (`industries`, `titles`, `locationCountries`, `employeeMin`/`Max`,
    `seniorities`, `functions`, `fundingStages`, `revenueRanges`, `keywords`,
    `technologies`). The audiences Zod silently STRIPS any non-canonical key on
    write. `src/services/persona-filter-map.ts` (`mapPersonaFiltersToCanonical`)
    translates one vocab into the other. Lossy edges (owned deliberately):
    `location` → `locationCountries` (all values, NO city/state split — apollo
    flattens location tiers anyway); `employeeRange` buckets →
    `employeeMin`/`employeeMax` (numeric range honored by both providers; `"N+"`
    → open max); `seniority` keeps only enum values; `department` → `functions`
    (lowercase, spaces→`_`). FAIL LOUD (`PersonaFilterMapError` → 502) on a
    persona key with no canonical target or an unparseable value — never a silent
    drop of a representable filter.
  - **Re-map of already-backfilled rows** — `POST /internal/remap-audience-filters`
    (`src/routes/backfill.ts`, service-auth) translates the filters of existing
    `source='brand_persona_backfill'` audiences in place. Scoped to rows still
    holding persona vocab; idempotent (a canonical row is `alreadyCanonical`, not
    re-written, so re-run is a no-op); `?dryRun=true` returns counts + a per-row
    before/after sample without writing; reversible (rows stay provenance-tagged).
    Kept (idempotent + harmless) even though the backfill is done.
  - **`audiences.source`** = provenance: `'brand_persona_backfill'` for
    backfilled rows, null for native rows. (Distinct from
    `audience_members.source` = provider.)

### Description backfill (pre-#82 rows) — `POST /internal/backfill-audience-descriptions`

#82 added + persisted the per-audience `description` and `serializeAudience`
returns it, but it only WRITES it for NEW audiences (the `/suggest` layer-1).
Rows created before #82 have `description = null`, so the dashboard "Described
as" line stays blank for them (it deliberately NEVER falls back to the shared
batch `nlPrompt`). This one-time sweep (`src/routes/backfill.ts`, service-auth)
generates a one-sentence `description` for every `description IS NULL` audience
from the row's **own name + filters** and writes it.

- **Idempotent** — scoped to `description IS NULL`, so a re-run only sees rows
  still null; already-described audiences are untouched and a clean re-run
  reports `backfilled:0`. **Dry-runnable** — `?dryRun=true` counts the null rows
  + returns an `{id,name}` sample WITHOUT calling the LLM or writing (free
  preview, no spend). **Never the `nlPrompt`** — derived only from name+filters
  (`generateAudienceDescription` in `src/services/audiences.ts`).
- **LLM via chat-service's ORG-LESS platform path** — `platformCompleteJson` →
  `POST /internal/platform-complete` (service-auth, no org/user), Gemini JSON
  with a `responseSchema` + `disableThinking` (`google`/`flash-pro`, same
  reliability setup as `/suggest`, v0.18.5).
  **chat-service OWNS the cost** (platform-run declaration lives there) — so
  human-service declares none, and a historical backfill we owe users does NOT
  retroactively bill their orgs (and a sweep-all-orgs job has no `x-user-id`
  anyway). The invariant holds, exactly as for `/suggest` + avatar.
- **Per-row resilience + fail-loud split** — a row whose generation yields no
  usable description is logged + counted in `failed` + left null (retried on the
  next re-run); a real chat-service outage (`ChatServiceError` status 0 /
  unreachable) or missing config (`ChatConfigError`) aborts the sweep loudly
  (502) — partial progress persists, a re-run resumes (only null rows remain).
- **NOT on boot** — O(N) over the audiences table × one LLM call each would
  block port-bind; trigger MANUALLY after deploy (`?dryRun=true` to size, then
  `?dryRun=false`). Kept idempotent + harmless after the one run, like the
  filter re-map above.

### apify→apollo migration (APOLLO-ONLY cutover) — `POST /internal/migrate-apify-audiences-to-apollo`

One-time sweep that retires every existing apify audience and replaces it with an
equivalent **apollo** audience, paired with the code cutover (apify dropped from
default routing + the suggest fan-out — see "APOLLO-ONLY" in the people gateway
section). `src/routes/backfill.ts` (service-auth); `migrateApifyAudienceToApollo`
in `src/services/audiences.ts` owns the per-row work.

- **Filters are BUILT by apollo-service, NOT copied** ("one filter vocabulary"
  Wave 2). Copying an apify-tuned neutral set to apollo would under-match, and
  human-service no longer holds Apollo's filter vocabulary anyway. Per audience we
  call apollo-service `POST /audiences/suggest-from-segment` with the row's name +
  description (`suggestApolloAudience` → apollo-service's own agentic refine loop)
  → `{ apolloAudienceId, faithful filters, count }`. The apify `filters`/
  `apify_count` of the retired row are left intact (reversibility).
- **Two-row, status-mirrored.** Atomically (one txn/row): the apify row is renamed
  `"<name> [Apify]"` + set `status='deprecated'`, and a NEW apollo audience is
  inserted with the original name, `provider='apollo'`, the `apollo_audience_id`
  pointer + cached faithful filters, **the source row's status mirrored** (an
  `active` apify audience → `active` apollo; a `suggested` one stays `suggested` —
  never auto-activate what the user never chose), `apolloCount` from the build, and
  `source='migrated_from_apify'` (provenance for reversibility). The deprecated
  apify row's `canonical_audience_id` is set to the new apollo id in the SAME txn,
  so membership/stats reads resolve it to the live twin (see "Canonical resolution"
  above). Pre-existing deprecated rows (migrated before this link existed) are
  linked by `POST /internal/backfill-canonical-audience-links`.
- **Identity.** apollo-service's suggest endpoint is org-scoped (it owns + meters
  the LLM cost it incurs against the row's org); the sweep uses each row's own
  `org_id` + `created_by_user_id` (all prod apify rows have it). human-service
  declares no cost (apollo-service is the cost owner). NOTE: unlike the prior
  platform-LLM path, this org-bills the small set of migrated rows — it is a
  one-time admin sweep.
- **Idempotent** — scoped to `provider='apify' AND status<>'deprecated'`, so a
  re-run skips already-migrated rows (now `deprecated`) → clean re-run migrates 0.
  **Dry-runnable** — `?dryRun=true` counts the apify rows + samples `{id,name,status}`
  WITHOUT calling apollo-service or writing. **Reversible** — DELETE the
  `source='migrated_from_apify'` rows + un-rename/un-deprecate the apify rows.
- **Per-row resilience + fail-loud split** — a row whose apollo-service build
  yields **no usable filter set** (empty) is counted in `failed` + left untouched
  (retried on re-run); a missing apollo/chat config aborts the sweep loudly
  (502) — already-migrated rows persist (each is one atomic txn).
- **NOT on boot** — O(N) × an agentic LLM loop each; trigger MANUALLY after deploy
  (`?dryRun=true` to size, then `?dryRun=false`).

### Audience suggestion (onboarding) — `POST /orgs/audiences/suggest`

Turns a natural-language audience description into a **set of persisted
candidate audiences** the user picks from, during onboarding. `requireOrgAndUser`
(`x-user-id` needed for chat-service + provider key resolution).
`src/services/audiences.ts` `suggestAudiences` owns it; `src/lib/chat-client.ts`
is the chat-service client.

**Two stages — layer-1 decompose (human-service) → per-segment faithful-Apollo
build (apollo-service) → persist:** ("one filter vocabulary" Wave 2 — the
in-human-service Layer-2 agentic loop + apolloDslToNeutral mapper are DELETED;
apollo-service owns the NL→faithful-Apollo-filters loop now.)

1. **LAYER 1 (provider-agnostic, ONE LLM call via chat-service)** —
   `decomposeSegments` reads the caller's segmentation intent ("US and Europe
   separately", "split by seniority", "one broad list") and emits a SET of
   **named** audiences `{ name (≤4 words), description }`. There is **no hard cap**:
   Layer 1 emits every distinct audience it infers. When the prompt explicitly
   spans independent axes that both change provider filters, Layer 1 produces the
   combinations, not a broad merged bucket (e.g. founders + heads of growth + solo
   marketers × B2B SaaS + digital product companies = 6 audiences). Each
   `description` is the complete, self-contained prompt for the apollo build: it
   must carry every shared and segment-specific constraint. **No rule-based
   post-processing after layer 1** (no regex extraction, no forced filter merge) —
   fix the layer-1 prompt/schema if a constraint is missing.
2. **APOLLO BUILD (per segment, apollo-service owns it)** — `suggestApolloAudience`
   calls apollo-service `POST /audiences/suggest-from-segment` with
   `{ name, description, brandId }`; apollo-service runs its agentic NL→faithful-
   Apollo-filters refine loop (LLM via chat-service, free Apollo dry-runs for live
   counts) INTERNALLY and returns `{ apolloAudienceId, filters (faithful, opaque),
   count }`. human-service does NOT build, validate, or even understand Apollo's
   filter vocabulary — it just routes + caches the opaque result. Best-provider
   collapse **degenerates to apollo** (apify is inert; existing apify audiences are
   migrated separately).
3. **PERSIST** — each segment's result is written as an `audiences` row at status
   **`suggested`** (INACTIVE — never live until flipped to `active` via
   `PATCH /orgs/audiences/{id}/status`), storing `apollo_audience_id` (the pointer)
   + the cached faithful `filters` + `apollo_count`. The `audienceId`s are returned
   so the front activates the chosen ones. Unique per `(org_id, brand_id,
   lower(name))`; re-running refreshes a still-`suggested` row in place, never
   mutates an `active`/`paused`/`archived` one.

- **Two cost owners, none here.** Layer 1's LLM runs via chat-service `POST
  /complete` (`google`, `flash-pro`, `disableThinking:true`, a Gemini
  `responseSchema` = `LAYER1_RESPONSE_SCHEMA`); chat-service owns that cost. The
  apollo build's LLM + dry-runs are owned by **apollo-service** (which calls
  chat-service internally). So **human-service still declares no cost** — the
  invariant holds.
- **Reliability — Layer-1 retry + per-segment fault tolerance.** `chat-client`
  retries a transient response status (502/429/503) + a missing/malformed `json`
  field (bounded 250/500/1000ms) in addition to the connect-phase retry (NOT 4xx —
  400/401/402 are deterministic). The per-segment apollo builds run under
  `Promise.allSettled`: one segment's apollo-service failure doesn't nuke the
  batch; still **fails loud (502)** when EVERY segment failed. apollo-service's
  HTTP failures surface as a fail-loud `ProviderError` → 502 (connect-phase
  retry via the gateway's `fetchWithConnectRetry`). An empty filter set from
  apollo-service is honestly returned as a candidate (apollo-service confirms a
  real audience or fails loud, so `validationError` is always null, `truncated`
  always false — both retained for response-shape stability only).
- **Granularity is emergent from the NL, not an input.** Input is ONLY
  `{nlPrompt, brandId}` — no `strategy`/count knob. Layer 1 reads the caller's own
  segmentation intent and emits one **named** audience per implied segment.
- **Stateful — persists `suggested` rows, returns `audienceId`s.** The front
  displays them, the user picks, and the front **activates** the chosen ones via
  `PATCH /orgs/audiences/{id}/status {status:"active"}` (existing endpoint, no new
  save). Unselected `suggested` rows stay inactive (filterable via
  `GET /orgs/audiences?status=suggested`; never surface in the brand's active view).
- **Env vars**: `CHAT_SERVICE_URL`, `CHAT_SERVICE_API_KEY` (Layer 1) +
  `APOLLO_SERVICE_URL`, `APOLLO_SERVICE_API_KEY` (the apollo build) — read at call
  time, fail the request loudly if absent (`ChatConfigError`/`ProviderConfigError`
  → 502).
- **Onboarding-before-balance caveat**: the LLM authorizes against the org balance
  (in chat-service / apollo-service); a zero-balance org → 502. The product fix is
  onboarding credits at the billing layer, not a cost-skip here.

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
- **`people`, `audiences`, `audience_members`** (audiences v1): `org_id` +
  `brand_id` uuid (new-table convention); `source` / `confidence` text.
- **`audience_teaser_buffer`** (serve-next apollo drain buffer): `org_id` uuid
  (new-table convention); `audience_id` uuid FK → `audiences` (ON DELETE CASCADE);
  `provider_person_id` / `linkedin_url` text.

The same request can hit both column families because the value passed in
`x-org-id` is text-coercible-to-uuid in practice. New tables use `uuid`.

> **Naming caveat — `people` is the canonical person, NOT `humans`.** The legacy
> `humans` table is expert-profiles (v0). The CRM-v2 plan below predates the
> audiences feature and calls the future canonical contact table `humans`; that
> name is taken, so the realized canonical person dimension is **`people`**
> (`audience_members.person_id` → `people.id`). When CRM v2 lands it should
> reuse `people` (and may backfill `list_members.human_id` → `people.id`) rather
> than introduce a second canonical table.

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

## Workflow tracking headers (`x-campaign-id` / `x-brand-id` / `x-workflow-slug` / `x-audience-id`)

workflow-service stamps these optional tracking headers on every campaign-DAG
call. `parseOptionalTrackingHeaders` (`src/middleware/auth.ts`) reads them into
`res.locals` and `WorkflowTrackingHeaders` is the single block carrying them;
`workflowTrackingToHeaders` is the ONE downstream-header builder that serializes
the whole block. Every internal sibling call forwards the block via that builder
(`people-providers` → apollo/apify, `runs.ts` → runs-service, `keys.ts` →
key-service, `scraping.ts` → scraping-service, `chat-client.ts` → chat-service)
— never cherry-picked field-by-field. Add a new tracking header in ONE place
(the builder) and it auto-propagates everywhere.

- **`x-audience-id`** = the campaign's PRIORITY audience (the one campaign-service
  picked at run start), the key for **per-audience cost attribution**
  (runs-service aggregates `SUM(cost) GROUP BY COALESCE(runs_costs.audience_id,
  runs.audience_id)` — flat, no rollup, so every cost row must carry it). human-
  service **declares no cost** (apollo/apify own the search reveal; chat-service
  owns the LLM/image), so its only job is **propagation**: read the header inbound,
  forward it to those internal siblings so THEY tag their own runs-service cost
  rows. Absent outside the campaign flow ⟹ omitted, never thrown.
- **Egress guardrail**: every downstream URL human-service calls
  (apollo/apify/chat/runs/key/scraping) is an INTERNAL sibling — the actual
  vendor (anthropic/gemini/apollo.io/apify actor) is reached INSIDE those
  services, so the tracking block never leaves the internal mesh. No external
  egress here to strip.
- Note: `lead_serves.audience_id` (bronze, provenance) is the audience a serve
  was recorded UNDER (membership tagging) — distinct from the `x-audience-id`
  cost-attribution header, though in the serve-next campaign flow they coincide.

## Cold-start instrumentation

`src/instrumentation.ts` registers `HUMAN_SERVICE_API_KEY` as a platform key
in key-service so other services can resolve it without configuring local
env vars. Idempotent and safe to call on every boot. Skipped silently in
local dev / tests when `KEY_SERVICE_URL` is not set.
