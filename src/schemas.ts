import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);
export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "apiKey", {
  type: "apiKey",
  in: "header",
  name: "X-API-Key",
  description: "Service-to-service API key",
});

const identityHeaders = z.object({
  "x-org-id": z.string().uuid().openapi({ description: "Internal org UUID from client-service" }),
  "x-user-id": z.string().uuid().openapi({ description: "Internal user UUID from client-service" }),
  "x-run-id": z.string().uuid().openapi({ description: "Caller's run ID — used as parentRunId when creating this service's own run" }),
  "x-campaign-id": z.string().optional().openapi({ description: "Campaign ID — injected by workflow-service on DAG calls" }),
  "x-brand-id": z.string().optional().openapi({ description: "Brand ID(s) — comma-separated UUIDs when multi-brand (e.g. 'uuid1,uuid2,uuid3')" }),
  "x-workflow-slug": z.string().optional().openapi({ description: "Workflow slug — injected by workflow-service on DAG calls" }),
});

// --- Shared schemas ---

export const ErrorSchema = z
  .object({
    error: z.string(),
  })
  .openapi("Error");

// --- Sub-types (methodology) ---

export const FrameworkSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    applicationContext: z.string(),
  })
  .openapi("Framework");

export const ToneProfileSchema = z
  .object({
    register: z.string(),
    pace: z.string(),
    vocabulary: z.string(),
    perspective: z.string(),
    examples: z.array(z.string()),
  })
  .openapi("ToneProfile");

export const PersuasionStyleSchema = z
  .object({
    primary: z.string(),
    techniques: z.array(z.string()),
    callToAction: z.string(),
  })
  .openapi("PersuasionStyle");

// --- Human ---

export const HumanSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    bio: z.string().nullable(),
    expertise: z.array(z.string()).nullable(),
    knownFor: z.string().nullable(),
    imageUrl: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Human");

// --- Methodology ---

export const MethodologySchema = z
  .object({
    humanId: z.string().uuid(),
    frameworks: z.array(FrameworkSchema).nullable(),
    strategicPatterns: z.array(z.string()).nullable(),
    toneOfVoice: ToneProfileSchema.nullable(),
    persuasionStyle: PersuasionStyleSchema.nullable(),
    contentSignatures: z.array(z.string()).nullable(),
    avoids: z.array(z.string()).nullable(),
    extractionModel: z.string().nullable(),
    extractedAt: z.string().nullable(),
  })
  .openapi("Methodology");

// --- POST /humans (upsert) ---

export const UpsertHumanRequestSchema = z
  .object({
    name: z.string().min(1),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
    urls: z.array(z.string().url()).min(1),
    bio: z.string().optional(),
    expertise: z.array(z.string()).optional(),
    knownFor: z.string().optional(),
    imageUrl: z.string().url().optional(),
    maxPages: z.number().int().min(1).max(20).optional(),
  })
  .openapi("UpsertHumanRequest");

export const UpsertHumanResponseSchema = z
  .object({
    human: HumanSchema,
    created: z.boolean(),
  })
  .openapi("UpsertHumanResponse");

registry.registerPath({
  method: "post",
  path: "/humans",
  summary: "Create or update a human expert",
  security: [{ apiKey: [] }],
  request: {
    headers: identityHeaders,
    body: {
      content: {
        "application/json": { schema: UpsertHumanRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Human created or updated",
      content: {
        "application/json": { schema: UpsertHumanResponseSchema },
      },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

// --- GET /humans ---

export const ListHumansResponseSchema = z
  .object({
    humans: z.array(HumanSchema),
  })
  .openapi("ListHumansResponse");

registry.registerPath({
  method: "get",
  path: "/humans",
  summary: "List humans for an org",
  security: [{ apiKey: [] }],
  request: {
    headers: identityHeaders,
  },
  responses: {
    200: {
      description: "Humans found",
      content: {
        "application/json": { schema: ListHumansResponseSchema },
      },
    },
    401: { description: "Unauthorized" },
  },
});

// --- GET /humans/:id ---

export const GetHumanResponseSchema = z
  .object({
    human: HumanSchema,
  })
  .openapi("GetHumanResponse");

registry.registerPath({
  method: "get",
  path: "/humans/{id}",
  summary: "Get human by ID",
  security: [{ apiKey: [] }],
  request: {
    headers: identityHeaders,
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Human found",
      content: {
        "application/json": { schema: GetHumanResponseSchema },
      },
    },
    404: {
      description: "Human not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

// --- GET /humans/:id/methodology ---

export const GetMethodologyResponseSchema = z
  .object({
    methodology: MethodologySchema,
    isExpired: z.boolean().optional(),
  })
  .openapi("GetMethodologyResponse");

registry.registerPath({
  method: "get",
  path: "/humans/{id}/methodology",
  summary: "Get cached methodology for a human",
  security: [{ apiKey: [] }],
  request: {
    headers: identityHeaders,
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Methodology found",
      content: {
        "application/json": { schema: GetMethodologyResponseSchema },
      },
    },
    404: {
      description: "Methodology not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

// --- POST /humans/:id/extract ---

export const ExtractRequestSchema = z
  .object({
    forceRefresh: z.boolean().optional(),
  })
  .openapi("ExtractRequest");

export const ExtractResponseSchema = z
  .object({
    human: HumanSchema,
    methodology: MethodologySchema,
    pagesScraped: z.number().int(),
  })
  .openapi("ExtractResponse");

registry.registerPath({
  method: "post",
  path: "/humans/{id}/extract",
  summary: "Trigger scrape and AI methodology extraction",
  security: [{ apiKey: [] }],
  request: {
    headers: identityHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: ExtractRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Extraction completed",
      content: {
        "application/json": { schema: ExtractResponseSchema },
      },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Human not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

// --- POST /internal/transfer-brand ---

export const TransferBrandRequestSchema = z
  .object({
    sourceBrandId: z.string().uuid(),
    sourceOrgId: z.string().uuid(),
    targetOrgId: z.string().uuid(),
    targetBrandId: z.string().uuid().optional(),
  })
  .openapi("TransferBrandRequest");

export const TransferBrandResponseSchema = z
  .object({
    updatedTables: z.array(
      z.object({
        tableName: z.string(),
        count: z.number().int(),
      })
    ),
  })
  .openapi("TransferBrandResponse");

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  summary: "Transfer a solo-brand from one org to another",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: TransferBrandRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Brand transferred",
      content: {
        "application/json": { schema: TransferBrandResponseSchema },
      },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

// --- CRM v1: lists + list_members ---
//
// Identity headers for /orgs/lists/* endpoints. Only x-org-id is strictly
// required; x-user-id is optional (populates created_by_user_id /
// added_by_user_id). x-run-id is optional and used as parentRunId for
// run-tracking when present.

const orgsListsHeaders = z.object({
  "x-org-id": z.string().uuid().openapi({ description: "Internal org UUID from client-service" }),
  "x-user-id": z
    .string()
    .uuid()
    .optional()
    .openapi({ description: "Internal user UUID — populates created_by/added_by columns when present" }),
  "x-run-id": z
    .string()
    .uuid()
    .optional()
    .openapi({ description: "Caller's run ID — used as parentRunId when creating this service's run" }),
});

export const ListSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    brandId: z.string().uuid().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    createdByUserId: z.string().uuid().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("List");

export const ListMemberSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    listId: z.string().uuid(),
    sourceService: z.string(),
    sourceResourceId: z.string(),
    sourceAccountId: z.string().uuid().nullable(),
    humanId: z.string().uuid().nullable(),
    addedByUserId: z.string().uuid().nullable(),
    addedAt: z.string(),
  })
  .openapi("ListMember");

// --- POST /orgs/lists ---

export const CreateListRequestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    brandId: z.string().uuid().optional(),
  })
  .openapi("CreateListRequest");

export const CreateListResponseSchema = z
  .object({ list: ListSchema })
  .openapi("CreateListResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/lists",
  summary: "Create a CRM list",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    body: { content: { "application/json": { schema: CreateListRequestSchema } } },
  },
  responses: {
    201: { description: "List created", content: { "application/json": { schema: CreateListResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

// --- GET /orgs/lists ---

export const ListListsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  brandId: z.string().uuid().optional(),
});

export const ListListsResponseSchema = z
  .object({
    lists: z.array(ListSchema),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi("ListListsResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/lists",
  summary: "List CRM lists for an org",
  security: [{ apiKey: [] }],
  request: { headers: orgsListsHeaders, query: ListListsQuerySchema },
  responses: {
    200: { description: "Lists found", content: { "application/json": { schema: ListListsResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

// --- GET /orgs/lists/{id} ---

export const GetListResponseSchema = z
  .object({ list: ListSchema })
  .openapi("GetListResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/lists/{id}",
  summary: "Get a CRM list by id",
  security: [{ apiKey: [] }],
  request: { headers: orgsListsHeaders, params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "List found", content: { "application/json": { schema: GetListResponseSchema } } },
    404: { description: "List not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

// --- PATCH /orgs/lists/{id} ---

export const UpdateListRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    brandId: z.string().uuid().nullable().optional(),
  })
  .openapi("UpdateListRequest");

registry.registerPath({
  method: "patch",
  path: "/orgs/lists/{id}",
  summary: "Update a CRM list",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: UpdateListRequestSchema } } },
  },
  responses: {
    200: { description: "List updated", content: { "application/json": { schema: GetListResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "List not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

// --- DELETE /orgs/lists/{id} ---

registry.registerPath({
  method: "delete",
  path: "/orgs/lists/{id}",
  summary: "Delete a CRM list (cascades to members)",
  security: [{ apiKey: [] }],
  request: { headers: orgsListsHeaders, params: z.object({ id: z.string().uuid() }) },
  responses: {
    204: { description: "List deleted" },
    404: { description: "List not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

// --- GET /orgs/lists/{id}/members ---

export const ListMembersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const ListMembersResponseSchema = z
  .object({
    members: z.array(ListMemberSchema),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi("ListMembersResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/lists/{id}/members",
  summary: "Get members of a CRM list",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    params: z.object({ id: z.string().uuid() }),
    query: ListMembersQuerySchema,
  },
  responses: {
    200: { description: "Members found", content: { "application/json": { schema: ListMembersResponseSchema } } },
    404: { description: "List not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

// --- POST /orgs/lists/{id}/members (bulk add, idempotent) ---

const MemberInputSchema = z.object({
  sourceService: z.string().min(1).optional(),
  sourceResourceId: z.string().min(1),
  sourceAccountId: z.string().uuid().optional(),
});

export const BulkAddMembersRequestSchema = z
  .object({ members: z.array(MemberInputSchema).min(1) })
  .openapi("BulkAddMembersRequest");

export const BulkAddMembersResponseSchema = z
  .object({ added: z.number().int(), skipped: z.number().int() })
  .openapi("BulkAddMembersResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/lists/{id}/members",
  summary: "Bulk add members to a list (idempotent on (list_id, source_service, source_resource_id))",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: BulkAddMembersRequestSchema } } },
  },
  responses: {
    200: { description: "Bulk add complete", content: { "application/json": { schema: BulkAddMembersResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "List not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

// --- DELETE /orgs/lists/{id}/members (bulk remove) ---

export const BulkRemoveMembersRequestSchema = z
  .object({ members: z.array(MemberInputSchema).min(1) })
  .openapi("BulkRemoveMembersRequest");

export const BulkRemoveMembersResponseSchema = z
  .object({ removed: z.number().int(), notFound: z.number().int() })
  .openapi("BulkRemoveMembersResponse");

registry.registerPath({
  method: "delete",
  path: "/orgs/lists/{id}/members",
  summary: "Bulk remove members from a list",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: BulkRemoveMembersRequestSchema } } },
  },
  responses: {
    200: { description: "Bulk remove complete", content: { "application/json": { schema: BulkRemoveMembersResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "List not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

// --- People gateway (v1): /orgs/people/* ---
//
// Provider-agnostic façade over apollo-service (rich search + enrich) and
// apify-service (verified-email waterfall). Normalizes both into one neutral
// `Person` shape whose field names mirror lead-service FullLead. Stateless:
// human-service routes + normalizes, declares no cost (apollo/apify own the
// paid call), forwards x-run-id for downstream tracing.

const providerEnum = z
  .enum(["apollo", "apify"])
  .openapi({ description: "Lead provider to route to. Explicit choice wins over `need`." });

// People gateway requires x-org-id AND x-user-id (apollo/apify need x-user-id
// for key resolution / attribution). x-run-id optional (used downstream for
// cost tracking when present).
const peopleHeaders = z.object({
  "x-org-id": z.string().uuid().openapi({ description: "Internal org UUID from client-service" }),
  "x-user-id": z.string().uuid().openapi({ description: "Internal user UUID — required; forwarded to apollo/apify" }),
  "x-run-id": z
    .string()
    .uuid()
    .optional()
    .openapi({ description: "Caller's run ID — forwarded for downstream cost tracking when present" }),
});

const seniorityEnum = z.enum([
  "entry",
  "senior",
  "manager",
  "director",
  "vp",
  "c_suite",
  "owner",
  "founder",
  "partner",
]);

export const PeopleSearchFiltersSchema = z
  .object({
    titles: z.array(z.string().min(1)).optional(),
    seniorities: z.array(seniorityEnum).optional(),
    functions: z.array(z.string().min(1)).optional().openapi({
      description: "Job functions. Honored by apify only — apollo has no functions search filter.",
    }),
    locationCountries: z.array(z.string().min(1)).optional(),
    locationStates: z.array(z.string().min(1)).optional(),
    locationCities: z.array(z.string().min(1)).optional(),
    companyNames: z.array(z.string().min(1)).optional().openapi({
      description: "Company names. Honored by apify only — apollo searches by domain/industry, not name.",
    }),
    companyDomains: z.array(z.string().min(1)).optional(),
    industries: z.array(z.string().min(1)).optional(),
    keywords: z.array(z.string().min(1)).optional(),
    employeeMin: z.number().int().positive().optional(),
    employeeMax: z.number().int().positive().optional(),
    companySizes: z.array(z.string().min(1)).optional().openapi({
      description: "Company size buckets. apify only.",
    }),
    revenueRanges: z.array(z.string().min(1)).optional().openapi({
      description: "Annual revenue ranges. apify + apollo (apollo `revenueRange`).",
    }),
    fundingStages: z.array(z.string().min(1)).optional().openapi({
      description: "Latest funding stage. apify only.",
    }),
    technologies: z.array(z.string().min(1)).optional().openapi({
      description: "Tech stack. apify + apollo (apollo technology UIDs).",
    }),
  })
  .openapi("PeopleSearchFilters");

export const NeutralOrganizationSchema = z
  .object({
    name: z.string().nullable(),
    domain: z.string().nullable(),
    websiteUrl: z.string().nullable(),
    industry: z.string().nullable(),
    estimatedNumEmployees: z.number().nullable(),
    linkedinUrl: z.string().nullable(),
    logoUrl: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    country: z.string().nullable(),
  })
  .openapi("NeutralOrganization");

export const PersonSchema = z
  .object({
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    name: z.string().nullable(),
    title: z.string().nullable(),
    headline: z.string().nullable(),
    seniority: z.string().nullable(),
    email: z.string().nullable(),
    emailStatus: z.string().nullable(),
    catchAll: z.boolean().nullable(),
    inferred: z.boolean().nullable(),
    linkedinUrl: z.string().nullable(),
    photoUrl: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    country: z.string().nullable(),
    provider: providerEnum,
    providerPersonId: z.string().nullable().openapi({
      description: "apollo person id (usable for a later enrich). null for apify.",
    }),
    organization: NeutralOrganizationSchema.nullable(),
  })
  .openapi("Person");

// --- POST /orgs/people/search ---

export const PeopleSearchRequestSchema = z
  .object({
    provider: providerEnum.optional(),
    need: z.literal("verified_email").optional().openapi({
      description: "Intent routing: 'verified_email' routes to apify. Ignored if `provider` is set.",
    }),
    filters: PeopleSearchFiltersSchema.optional(),
    nextPage: z.boolean().optional().openapi({
      description: "apollo only: omit filters and advance the server-managed cursor for the next page.",
    }),
    limit: z.number().int().min(1).max(1000).optional().openapi({
      description: "apify only: max leads to return (provider cap 1000). Defaults to 100 (one page).",
    }),
    offset: z.number().int().min(0).optional().openapi({
      description: "apify only: pagination offset (pass back `nextOffset` from the prior page).",
    }),
  })
  .openapi("PeopleSearchRequest");

export const PeopleSearchResponseSchema = z
  .object({
    provider: providerEnum,
    people: z.array(PersonSchema),
    done: z.boolean(),
    total: z.number().int().openapi({
      description: "Total matchable. apify: pipelinelabs-only signal (provider cursor, not a cross-source-exact total).",
    }),
    nextOffset: z.number().int().nullable().openapi({
      description: "apify offset for the next page (null when done / apollo cursor-based).",
    }),
  })
  .openapi("PeopleSearchResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/people/search",
  summary: "Search people via a lead provider (apollo or apify), normalized",
  security: [{ apiKey: [] }],
  request: {
    headers: peopleHeaders,
    body: { content: { "application/json": { schema: PeopleSearchRequestSchema } } },
  },
  responses: {
    200: { description: "Page of normalized people", content: { "application/json": { schema: PeopleSearchResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- POST /orgs/people/resolve-email ---

export const ResolveEmailRequestSchema = z
  .object({
    provider: providerEnum.optional().openapi({
      description: "Defaults to apify (verified-email specialist). Set 'apollo' to use Apollo match.",
    }),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    domain: z.string().min(1),
    includeInferred: z.boolean().optional().openapi({
      description: "apify only: include pattern-inferred emails in the waterfall.",
    }),
  })
  .openapi("ResolveEmailRequest");

export const ResolveEmailResponseSchema = z
  .object({
    provider: providerEnum,
    person: PersonSchema.nullable(),
  })
  .openapi("ResolveEmailResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/people/resolve-email",
  summary: "Resolve a verified email for a known person (name + domain)",
  security: [{ apiKey: [] }],
  request: {
    headers: peopleHeaders,
    body: { content: { "application/json": { schema: ResolveEmailRequestSchema } } },
  },
  responses: {
    200: { description: "Resolved person (or null)", content: { "application/json": { schema: ResolveEmailResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- POST /orgs/people/search/dry-run ---

export const DryRunRequestSchema = z
  .object({
    provider: providerEnum.optional(),
    filters: PeopleSearchFiltersSchema.optional(),
  })
  .openapi("PeopleDryRunRequest");

export const DryRunResponseSchema = z
  .object({
    provider: providerEnum,
    totalEntries: z.number().int(),
  })
  .openapi("PeopleDryRunResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/people/search/dry-run",
  summary: "Count matches for filters without consuming credits (apollo + apify)",
  security: [{ apiKey: [] }],
  request: {
    headers: peopleHeaders,
    body: { content: { "application/json": { schema: DryRunRequestSchema } } },
  },
  responses: {
    200: { description: "Match count", content: { "application/json": { schema: DryRunResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- GET /orgs/people/filters-prompt ---

export const FiltersPromptQuerySchema = z.object({
  provider: providerEnum.optional(),
});

export const FiltersPromptResponseSchema = z
  .object({
    provider: providerEnum,
    prompt: z.string(),
    schemaVersion: z.string(),
  })
  .openapi("PeopleFiltersPromptResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/people/filters-prompt",
  summary: "LLM filter-shape prompt for a provider (apollo + apify)",
  security: [{ apiKey: [] }],
  request: { headers: peopleHeaders, query: FiltersPromptQuerySchema },
  responses: {
    200: { description: "Filter prompt + version hash", content: { "application/json": { schema: FiltersPromptResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- GET /health ---

export const HealthResponseSchema = z
  .object({
    status: z.string(),
    service: z.string(),
  })
  .openapi("HealthResponse");

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": { schema: HealthResponseSchema },
      },
    },
  },
});
