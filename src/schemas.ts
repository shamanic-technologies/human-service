import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { LAX_UUID_REGEX } from "./lib/uuid.js";

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
    annualRevenue: z.number().nullable(),
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
    timezone: z.string().nullable().openapi({
      description:
        "Recipient's IANA timezone (e.g. 'America/New_York'), threaded from the provider so downstream send-scheduling lands in the prospect's local business hours. null when the provider omits it.",
    }),
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
      description: "apify only: max leads to return (provider cap 1000). Defaults to 1 — apify bills per returned lead (each hit carries a verified email; no free teaser list), so the gateway takes the strict minimum unless you consciously raise it to batch.",
    }),
    offset: z.number().int().min(0).optional().openapi({
      description: "apify only: pagination offset (pass back `nextOffset` from the prior page).",
    }),
    audienceId: z.string().uuid().optional().openapi({
      description:
        "Tag returned (served) leads as members of this audience (provenance membership). The audience must belong to the org (404 otherwise). Tagging applies to billed serves only — apify search hits (every hit is billed). Does not change which filters are searched; the caller supplies filters as usual.",
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
      description:
        "Defaults to apollo (same as search). Set 'apify' for the verified-email waterfall. The reveal follows the provider that searched — a provider person id only means something to its own provider.",
    }),
    providerPersonId: z.string().min(1).optional().openapi({
      description:
        "apollo only: the apollo person id returned by a prior search. Reveals the verified email via apollo /enrich (the billed path, 1 credit). PREFERRED for apollo — apollo search masks last name + domain, so identity-based match can't be satisfied from a search hit.",
    }),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    domain: z.string().min(1).optional(),
    includeInferred: z.boolean().optional().openapi({
      description: "apify only: include pattern-inferred emails in the waterfall.",
    }),
    audienceId: z.string().uuid().optional().openapi({
      description:
        "Tag the resolved (served) person as a member of this audience (provenance membership). The audience must belong to the org (404 otherwise).",
    }),
  })
  .refine(
    (v) =>
      !!v.providerPersonId || (!!v.firstName && !!v.lastName && !!v.domain),
    {
      message:
        "Provide providerPersonId (apollo enrich-by-id) OR firstName + lastName + domain (identity resolve).",
    }
  )
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

// --- Audiences (v1): /orgs/audiences/* ---
//
// An audience is a saved neutral filter-set whose membership is computed
// dynamically (CDP "dynamic audience"). Members accrue by PROVENANCE: a person
// joins an audience iff a serve made under that audience returned them. CRUD is
// org-scoped (x-org-id; x-user-id optional, populates created_by). refresh-count
// additionally requires x-user-id (apollo/apify key resolution).

// Audience status lifecycle, mirroring brand-service persona semantics.
// "suggested" is the INACTIVE default for rows created by POST /orgs/audiences/
// suggest — the audience is never live for the brand until the caller flips it
// to "active" via PATCH /orgs/audiences/{id}/status.
// "deprecated" is a TERMINAL, admin-only state set by the apify→apollo migration
// (POST /internal/migrate-apify-audiences-to-apollo). It is NOT user-settable and
// cannot be transitioned out of (so a user can never reactivate a retired apify
// audience), and GET /orgs/audiences hides it by default — see
// ChangeAudienceStatusRequestSchema (user-settable subset) and the list route.
export const AudienceStatusSchema = z
  .enum(["suggested", "active", "paused", "archived", "deprecated"])
  .openapi("AudienceStatus");

export const AudienceSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    brandId: z.string().uuid(),
    name: z.string(),
    nlPrompt: z.string().nullable(),
    description: z.string().nullable().openapi({
      description:
        "One-sentence summary of who THIS audience targets, distinct from the shared batch nlPrompt. LLM-generated at /suggest time. null for rows predating this field.",
    }),
    provider: z.enum(["apollo", "apify"]).nullable(),
    apolloAudienceId: z.string().nullable().openapi({
      description:
        "Pointer to the faithful Apollo audience owned by apollo-service ('one filter vocabulary' Wave 2). Set for apollo audiences; null for apify (legacy) rows and pre-Wave-2 rows not yet backfilled. The faithful filters live in apollo-service; the `filters` field below is human-service's opaque cache of them.",
    }),
    status: AudienceStatusSchema,
    // Provenance: "brand_persona_backfill" for backfilled rows, else null.
    source: z.string().nullable(),
    canonicalAudienceId: z.string().uuid().nullable().openapi({
      description:
        "When this audience is a deprecated provider-variant (e.g. retired '<base> [Apify]' from the apify->apollo migration), the id of its active canonical replacement. Membership/stats reads resolve a deprecated match to this audience. null for non-deprecated / unlinked rows.",
    }),
    // Opaque, provider-native filter object. For apollo audiences this is the
    // faithful Apollo filter object cached from apollo-service (apollo-service owns
    // its shape); for apify (legacy) rows it is the neutral PeopleSearchFilters.
    // human-service no longer builds or validates Apollo's filter vocabulary.
    filters: z.record(z.string(), z.unknown()).nullable(),
    avatarUrl: z.string().nullable().openapi({
      description:
        "Audience avatar as a hosted HTTP(S) URL. null until generated.",
    }),
    apolloCount: z.number().int().nullable(),
    apifyCount: z.number().int().nullable(),
    countedAt: z.string().nullable(),
    createdByUserId: z.string().uuid().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Audience");

export const CreateAudienceRequestSchema = z
  .object({
    name: z.string().min(1),
    brandId: z.string().uuid(),
    provider: z.enum(["apollo", "apify"]).optional().openapi({
      description:
        "The provider this audience commits to, when persisting a candidate from /suggest. Omit for a neutral audience.",
    }),
    nlPrompt: z.string().min(1).optional(),
    // Opaque, provider-native filter object stored as-is. For apollo audiences
    // this is the faithful Apollo filter object (apollo-service owns its shape);
    // for apify it is the neutral PeopleSearchFilters. No human-side validation.
    filters: z.record(z.string(), z.unknown()).optional(),
    apolloAudienceId: z.string().min(1).optional().openapi({
      description:
        "Pointer to the faithful Apollo audience owned by apollo-service, when persisting an apollo candidate. Omit for a neutral / apify audience.",
    }),
    apolloCount: z.number().int().min(0).nullish().openapi({
      description:
        "Optional count snapshot the caller already obtained from /orgs/people/search/dry-run (apollo). Stored as-is; refresh-count re-computes it server-side later. Accepts null (e.g. an apify-source candidate carries apolloCount: null).",
    }),
    apifyCount: z.number().int().min(0).nullish().openapi({
      description:
        "Optional apify count snapshot (see apolloCount). Accepts null (e.g. an apollo-source candidate carries apifyCount: null).",
    }),
  })
  .openapi("CreateAudienceRequest");

// An audience is immutable except its status (editing filters = a new audience).
// PATCH only accepts metadata (name / nlPrompt); brandId and filters are NOT
// editable. `.strict()` so a request that tries to change them fails loud (400)
// rather than being silently stripped. Status changes go through the dedicated
// PATCH /orgs/audiences/{id}/status route.
export const UpdateAudienceRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    nlPrompt: z.string().nullable().optional(),
  })
  .strict()
  .openapi("UpdateAudienceRequest");

// User-settable status subset: "deprecated" is admin-only (set solely by the
// apify→apollo migration), so a PATCH /status that tries to set it fails loud
// (400). "suggested" stays settable for parity with the prior behavior.
export const ChangeAudienceStatusRequestSchema = z
  .object({
    status: z.enum(["suggested", "active", "paused", "archived"]),
  })
  .strict()
  .openapi("ChangeAudienceStatusRequest");

export const ListAudiencesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  brandId: z.string().uuid().optional(),
  status: AudienceStatusSchema.optional(),
});

export const AudienceMembersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const AudienceStatsRequestSchema = z
  .object({
    emails: z.array(z.string().min(1)).optional(),
    personIds: z.array(z.string().uuid()).optional(),
  })
  .refine((v) => (v.emails?.length ?? 0) + (v.personIds?.length ?? 0) > 0, {
    message: "Provide at least one of emails or personIds.",
  })
  .openapi("AudienceStatsRequest");

export const GetAudienceResponseSchema = z
  .object({ audience: AudienceSchema })
  .openapi("GetAudienceResponse");

// A list item is a full Audience plus the server-computed contactability numbers
// the dashboard "Size" / "Remaining" columns render. Only the LIST endpoint
// carries these (it's the one the audiences table consumes); the single-audience
// GET / CRUD responses stay the plain AudienceSchema.
export const AudienceListItemSchema = AudienceSchema.extend({
  sizeCount: z.number().int().openapi({
    description:
      "Total contactable audience pool = the committed provider's count snapshot (apollo -> apolloCount, apify -> apifyCount). 0 for a never-counted audience.",
  }),
  availableToContactCount: z.number().int().openapi({
    description:
      "Pool members NOT suppressed within the 3-month re-contact window (never-served, or last served >3 months ago). Computed server-side from the same per-brand cross-provider suppression the serve path enforces.",
  }),
  availableToContactPct: z.number().int().openapi({
    description:
      "round(availableToContactCount / sizeCount * 100), integer 0..100. 0 when sizeCount is 0. Denominator is exactly sizeCount so Size and Remaining stay coherent.",
  }),
}).openapi("AudienceListItem");

export const ListAudiencesResponseSchema = z
  .object({
    audiences: z.array(AudienceListItemSchema),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi("ListAudiencesResponse");

export const AudienceMemberSchema = z
  .object({
    personId: z.string().uuid(),
    emailNorm: z.string().nullable(),
    linkedinUrlNorm: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    fullName: z.string().nullable(),
    companyDomain: z.string().nullable(),
    source: z.string().nullable(),
    confidence: z.string(),
    joinedAt: z.string(),
    lastServedAt: z.string(),
  })
  .openapi("AudienceMember");

export const ListAudienceMembersResponseSchema = z
  .object({
    members: z.array(AudienceMemberSchema),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi("ListAudienceMembersResponse");

export const AudienceStatsResponseSchema = z
  .object({
    matched: z.array(
      z.object({
        personId: z.string().uuid(),
        emailNorm: z.string().nullable(),
        fullName: z.string().nullable(),
        audiences: z.array(
          z.object({ audienceId: z.string().uuid(), name: z.string() })
        ),
      })
    ),
    unmatched: z.object({
      emails: z.array(z.string()),
      personIds: z.array(z.string()),
    }),
    byAudience: z.array(
      z.object({
        audienceId: z.string().uuid(),
        name: z.string(),
        brandId: z.string().uuid(),
        matchedCount: z.number().int(),
      })
    ),
  })
  .openapi("AudienceStatsResponse");

export const SuggestAudiencesRequestSchema = z
  .object({
    nlPrompt: z.string().min(1).openapi({
      description:
        "Natural-language audience description. The LLM reads the caller's own granularity intent from this text (e.g. 'split by country', 'founders in FR and DE separately') and emits one candidate per implied segment — granularity and count are NOT separate inputs.",
    }),
    brandId: z.string().uuid(),
  })
  .openapi("SuggestAudiencesRequest");

export const AudienceCandidateSchema = z
  .object({
    audienceId: z.string().uuid().openapi({
      description:
        "The id of the PERSISTED audience row (status 'suggested', inactive). The caller activates a chosen candidate via PATCH /orgs/audiences/{id}/status {status:'active'}.",
    }),
    name: z.string().openapi({
      description:
        "Short human label for this audience (<=4 words), shared across providers — the layer-1 segment name.",
    }),
    rationale: z.string().openapi({
      description: "One-sentence description of who this audience targets.",
    }),
    provider: z.literal("apollo").openapi({
      description:
        "Always 'apollo' — apollo-service owns the faithful filters; the candidate commits to apollo.",
    }),
    apolloAudienceId: z.string().openapi({
      description:
        "Pointer to the faithful Apollo audience apollo-service built + persisted for this segment.",
    }),
    filters: z.record(z.string(), z.unknown()).openapi({
      description:
        "The faithful Apollo filter object (opaque — apollo-service owns its shape), cached on the persisted audience row.",
    }),
    count: z.number().int().openapi({
      description:
        "The audience's live match count (free apollo dry-run snapshot from apollo-service).",
    }),
    status: AudienceStatusSchema.openapi({
      description: "Always 'suggested' (inactive) for a freshly-suggested audience.",
    }),
    validationError: z.string().nullable().openapi({
      description:
        "Retained for response-shape stability. apollo-service confirms a real audience (or fails loud), so always null.",
    }),
    truncated: z.boolean().openapi({
      description:
        "Reserved for response compatibility. Current Layer 1 has no hard cap, so freshly suggested candidates return false.",
    }),
  })
  .openapi("AudienceCandidate");

export const SuggestAudiencesResponseSchema = z
  .object({
    candidates: z.array(AudienceCandidateSchema),
  })
  .openapi("SuggestAudiencesResponse");

// --- POST /orgs/audiences/{id}/serve-next ---
export const ServeNextResponseSchema = z
  .object({
    status: z.enum(["served", "exhausted"]).openapi({
      description:
        "'served' ⟹ a fresh person is returned. 'exhausted' ⟹ no new match remains for this audience within the suppression window (person is null).",
    }),
    person: PersonSchema.nullable().openapi({
      description:
        "The next unserved person (real provider match on the audience's stored filters), recorded as served so the next call returns someone new. null when exhausted.",
    }),
  })
  .openapi("ServeNextResponse");

// --- POST /orgs/audiences/{id}/avatar ---
export const GenerateAudienceAvatarRequestSchema = z
  .object({
    prompt: z.string().min(1).optional().openapi({
      description:
        "Optional image prompt override (the dashboard AI-chat tool can steer the avatar). Omitted ⟹ chat-service is prompted from the audience's own descriptors.",
    }),
  })
  .strict()
  .openapi("GenerateAudienceAvatarRequest");

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/suggest",
  summary:
    "Suggest candidate audiences from a natural-language prompt (apollo + apify, LLM-generated, dry-run counted)",
  security: [{ apiKey: [] }],
  request: {
    headers: peopleHeaders,
    body: { content: { "application/json": { schema: SuggestAudiencesRequestSchema } } },
  },
  responses: {
    200: { description: "Candidate audiences", content: { "application/json": { schema: SuggestAudiencesResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "LLM / provider error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences",
  summary: "Create an audience (saved filter-set + optional count snapshot)",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    body: { content: { "application/json": { schema: CreateAudienceRequestSchema } } },
  },
  responses: {
    201: { description: "Audience created", content: { "application/json": { schema: GetAudienceResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/audiences",
  summary: "List audiences for an org (optional brandId filter)",
  security: [{ apiKey: [] }],
  request: { headers: orgsListsHeaders, query: ListAudiencesQuerySchema },
  responses: {
    200: { description: "Audiences found", content: { "application/json": { schema: ListAudiencesResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/stats",
  summary: "Per-audience membership stats for a list of emails / personIds",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    body: { content: { "application/json": { schema: AudienceStatsRequestSchema } } },
  },
  responses: {
    200: { description: "Stats", content: { "application/json": { schema: AudienceStatsResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/audiences/{id}",
  summary: "Get an audience by id",
  security: [{ apiKey: [] }],
  request: { headers: orgsListsHeaders, params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Audience found", content: { "application/json": { schema: GetAudienceResponseSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "patch",
  path: "/orgs/audiences/{id}",
  summary: "Update an audience's metadata (name / nlPrompt only — immutable otherwise)",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: UpdateAudienceRequestSchema } } },
  },
  responses: {
    200: { description: "Audience updated", content: { "application/json": { schema: GetAudienceResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "patch",
  path: "/orgs/audiences/{id}/status",
  summary: "Change an audience's status (active / paused / archived) — mutates only status",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: ChangeAudienceStatusRequestSchema } } },
  },
  responses: {
    200: { description: "Status changed", content: { "application/json": { schema: GetAudienceResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/orgs/audiences/{id}",
  summary: "Delete an audience (cascades members)",
  security: [{ apiKey: [] }],
  request: { headers: orgsListsHeaders, params: z.object({ id: z.string().uuid() }) },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/{id}/refresh-count",
  summary: "Re-snapshot apollo + apify counts via the free dry-run",
  security: [{ apiKey: [] }],
  request: { headers: peopleHeaders, params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Counts refreshed", content: { "application/json": { schema: GetAudienceResponseSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/{id}/serve-next",
  summary:
    "Serve the next unserved person of an audience (real provider match on its stored filters; records the serve; never repeats)",
  security: [{ apiKey: [] }],
  request: { headers: peopleHeaders, params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Next person, or an exhausted signal", content: { "application/json": { schema: ServeNextResponseSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Audience not servable (no provider / no filters)", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/{id}/avatar",
  summary:
    "(Re)generate the audience's avatar via chat-service and persist it as a hosted URL",
  security: [{ apiKey: [] }],
  request: {
    headers: peopleHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: GenerateAudienceAvatarRequestSchema } } },
  },
  responses: {
    200: { description: "Avatar generated; updated audience", content: { "application/json": { schema: GetAudienceResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "chat-service error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/audiences/{id}/members",
  summary: "List the canonical people who are members of an audience",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    params: z.object({ id: z.string().uuid() }),
    query: AudienceMembersQuerySchema,
  },
  responses: {
    200: { description: "Members", content: { "application/json": { schema: ListAudienceMembersResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

// --- Internal: one-time re-map of backfilled audience filters to canonical vocab ---
export const RemapAudienceFiltersQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', report counts + a before/after sample without writing. Defaults to false (real run).",
    }),
});

export const RemapAudienceFiltersResponseSchema = z
  .object({
    dryRun: z.boolean(),
    scanned: z.number().int().openapi({
      description: "Backfilled audiences inspected (source='brand_persona_backfill').",
    }),
    remapped: z.number().int().openapi({
      description: "Audiences whose filters were translated (0 on a dry-run).",
    }),
    wouldRemap: z.number().int().openapi({
      description: "Audiences that still hold persona vocab and would be translated.",
    }),
    alreadyCanonical: z.number().int().openapi({
      description: "Backfilled audiences already canonical (idempotent no-op).",
    }),
    sample: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          before: z.record(z.string(), z.unknown()),
          after: z.record(z.string(), z.unknown()),
        })
      )
      .openapi({ description: "Per-audience before/after preview (capped)." }),
  })
  .openapi("RemapAudienceFiltersResponse");

// --- Internal: one-time backfill of per-audience descriptions (pre-#82 rows) ---
export const BackfillAudienceDescriptionsQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', count null-description audiences + return an {id,name} sample WITHOUT calling the LLM or writing. Defaults to false (real run).",
    }),
});

export const BackfillAudienceDescriptionsResponseSchema = z
  .object({
    dryRun: z.boolean(),
    scanned: z.number().int().openapi({
      description: "Audiences with description IS NULL found by this sweep.",
    }),
    wouldBackfill: z.number().int().openapi({
      description: "Null-description audiences that would be backfilled (= scanned).",
    }),
    backfilled: z.number().int().openapi({
      description: "Audiences whose description was generated + written (0 on a dry-run).",
    }),
    failed: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          error: z.string(),
        })
      )
      .openapi({
        description:
          "Rows whose LLM generation failed (left null, retried on re-run).",
      }),
    sample: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().nullable(),
        })
      )
      .openapi({
        description:
          "Per-audience preview (capped): {id,name,description} — description is null on a dry-run, the generated sentence on a real run.",
      }),
  })
  .openapi("BackfillAudienceDescriptionsResponse");

registry.registerPath({
  method: "post",
  path: "/internal/backfill-audience-descriptions",
  summary:
    "One-time data fix: generate a per-audience one-sentence description (from name + filters via chat-service) for every audience whose description is null (idempotent, dry-runnable)",
  security: [{ apiKey: [] }],
  request: { query: BackfillAudienceDescriptionsQuerySchema },
  responses: {
    200: { description: "Backfill result", content: { "application/json": { schema: BackfillAudienceDescriptionsResponseSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "chat-service outage / missing config", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/remap-audience-filters",
  summary:
    "One-time data fix: translate backfilled audiences' filters from legacy persona vocab to the canonical PeopleSearchFilters vocab, in place (idempotent, dry-runnable, reversible)",
  security: [{ apiKey: [] }],
  request: { query: RemapAudienceFiltersQuerySchema },
  responses: {
    200: { description: "Re-map result", content: { "application/json": { schema: RemapAudienceFiltersResponseSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "unrepresentable persona filter", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- Internal: one-time apify→apollo audience migration ---
export const MigrateApifyAudiencesQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', scan the non-deprecated apify audiences + return a sample WITHOUT calling the LLM/apollo or writing. Defaults to false (real run).",
    }),
  async: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', respond 202 immediately and run the sweep in the background (each row's agentic refine can exceed an HTTP timeout; a whole-table run certainly does). Progress is durable per-row + observable via ?dryRun=true. Ignored when dryRun=true.",
    }),
});

export const MigrateApifyAudiencesResponseSchema = z
  .object({
    dryRun: z.boolean(),
    scanned: z.number().int().openapi({
      description: "Non-deprecated apify audiences inspected by this sweep.",
    }),
    wouldMigrate: z.number().int().openapi({
      description: "Apify audiences that would be migrated (= scanned on a dry-run).",
    }),
    migrated: z
      .array(
        z.object({
          apifyAudienceId: z.string(),
          apolloAudienceId: z.string(),
          name: z.string(),
          status: z.string(),
          apolloCount: z.number().int(),
        })
      )
      .openapi({
        description:
          "Per-audience result: the deprecated apify id, the new active apollo id (mirrored status), and the apollo count from the re-derived filters. Empty on a dry-run.",
      }),
    failed: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          error: z.string(),
        })
      )
      .openapi({
        description:
          "Apify audiences whose apollo re-derivation yielded no usable filter set (left untouched, retried on re-run).",
      }),
    sample: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.string(),
        })
      )
      .openapi({
        description:
          "Per-audience preview (capped): {id,name,status} of the apify rows that would migrate.",
      }),
  })
  .openapi("MigrateApifyAudiencesResponse");

registry.registerPath({
  method: "post",
  path: "/internal/migrate-apify-audiences-to-apollo",
  summary:
    "One-time data fix: for every non-deprecated apify audience, re-derive an equivalent apollo filter set (agentic refine, platform LLM), create a new apollo audience mirroring the source status, and mark the apify one 'deprecated' (idempotent, dry-runnable, reversible)",
  security: [{ apiKey: [] }],
  request: { query: MigrateApifyAudiencesQuerySchema },
  responses: {
    200: { description: "Migration result", content: { "application/json": { schema: MigrateApifyAudiencesResponseSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "apollo / chat-service outage / missing config", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- Internal: one-time backfill of canonical links on deprecated variants ---
export const BackfillCanonicalLinksQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', resolve which deprecated provider-variant audiences would link to an active sibling + return counts WITHOUT writing. Defaults to false (real run).",
    }),
});

export const BackfillCanonicalLinksResponseSchema = z
  .object({
    dryRun: z.boolean(),
    scanned: z.number().int().openapi({
      description:
        "Deprecated audiences with canonical_audience_id IS NULL inspected by this sweep.",
    }),
    linked: z.number().int().openapi({
      description:
        "Deprecated audiences resolved to exactly one active sibling + linked (0 on a dry-run; the would-link count is `wouldLink`).",
    }),
    wouldLink: z.number().int().openapi({
      description:
        "Deprecated audiences that resolve to exactly one active sibling (the count that would be / was linked).",
    }),
    skipped: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          reason: z.string(),
        })
      )
      .openapi({
        description:
          "Deprecated rows left unlinked: no provider-variant suffix, no active sibling, or (defensively) >1 sibling — never guessed.",
      }),
    sample: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          canonicalAudienceId: z.string(),
        })
      )
      .openapi({
        description:
          "Per-audience preview (capped): {id,name,canonicalAudienceId} of the deprecated rows that would link.",
      }),
  })
  .openapi("BackfillCanonicalLinksResponse");

registry.registerPath({
  method: "post",
  path: "/internal/backfill-canonical-audience-links",
  summary:
    "One-time data fix: link each deprecated provider-variant audience ('<base> [Apify]') to its active same-(org,brand)-base-name canonical sibling, so membership/stats reads resolve to the clean active audience (idempotent, dry-runnable, reversible; skips 0/ambiguous siblings)",
  security: [{ apiKey: [] }],
  request: { query: BackfillCanonicalLinksQuerySchema },
  responses: {
    200: { description: "Backfill result", content: { "application/json": { schema: BackfillCanonicalLinksResponseSchema } } },
    401: { description: "Unauthorized" },
  },
});

// --- Internal: one-time backfill of audience avatars (avatar_url IS NULL) ---
export const BackfillAudienceAvatarsQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', count live audiences missing an avatar + return a sample WITHOUT calling chat-service or writing. Defaults to false (real run).",
    }),
  async: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', respond 202 immediately and run the sweep in the background (image generation is slow; a whole-table run exceeds an HTTP timeout). Progress is durable per-row + observable via ?dryRun=true. Ignored when dryRun=true.",
    }),
});

export const BackfillAudienceAvatarsResponseSchema = z
  .object({
    dryRun: z.boolean(),
    started: z.boolean().optional().openapi({
      description: "Present (true) only on an async run — the sweep runs in the background.",
    }),
    scanned: z.number().int().openapi({
      description: "Live audiences (status<>'deprecated') with avatar_url IS NULL.",
    }),
    wouldFill: z.number().int().openapi({
      description: "Audiences that would get an avatar (= scanned on a dry-run).",
    }),
    filled: z.number().int().openapi({
      description: "Audiences whose avatar was generated + stored as a hosted URL (0 on a dry-run / async).",
    }),
    failed: z
      .array(
        z.object({ id: z.string(), name: z.string(), error: z.string() })
      )
      .openapi({
        description:
          "Audiences whose image generation failed; left null and retried on re-run.",
      }),
    sample: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .openapi({ description: "Per-audience preview (capped) of rows that would be filled." }),
  })
  .openapi("BackfillAudienceAvatarsResponse");

registry.registerPath({
  method: "post",
  path: "/internal/backfill-audience-avatars",
  summary:
    "One-time data fix: store hosted avatar URLs for every live audience whose avatar_url is null — idempotent, dry-runnable, async",
  security: [{ apiKey: [] }],
  request: { query: BackfillAudienceAvatarsQuerySchema },
  responses: {
    200: { description: "Backfill result", content: { "application/json": { schema: BackfillAudienceAvatarsResponseSchema } } },
    202: { description: "Async sweep started", content: { "application/json": { schema: BackfillAudienceAvatarsResponseSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "chat-service missing config", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- Internal: one-time backfill of apollo-audience pointers ---
// ("one filter vocabulary" Wave 2). For every apollo audience lacking
// apollo_audience_id, build a faithful Apollo audience via apollo-service and
// store the pointer + cached filters + count.
export const BackfillApolloPointersQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', count the apollo audiences missing a pointer + return a sample WITHOUT calling apollo-service or writing. Defaults to false (real run).",
    }),
  async: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', respond 202 immediately and run the sweep in the background (each row triggers apollo-service's agentic refine loop; a whole-table run exceeds an HTTP timeout). Progress is durable per-row + observable via ?dryRun=true. Ignored when dryRun=true.",
    }),
});

export const BackfillApolloPointersResponseSchema = z
  .object({
    dryRun: z.boolean(),
    started: z.boolean().optional().openapi({
      description: "Present (true) only on an async run — the sweep runs in the background.",
    }),
    scanned: z.number().int().openapi({
      description: "Apollo audiences (provider='apollo', status<>'deprecated') with apollo_audience_id IS NULL.",
    }),
    wouldBackfill: z.number().int().openapi({
      description: "Audiences that would get a pointer (= scanned on a dry-run).",
    }),
    backfilled: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          apolloAudienceId: z.string(),
          count: z.number().int(),
        })
      )
      .openapi({
        description:
          "Per-audience result: the human-service row id, the new apollo-service pointer, and the apollo count. Empty on a dry-run / async.",
      }),
    failed: z
      .array(z.object({ id: z.string(), name: z.string(), error: z.string() }))
      .openapi({
        description:
          "Audiences whose apollo-service build yielded no usable filter set or failed transiently; left untouched, retried on re-run.",
      }),
    sample: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .openapi({ description: "Per-audience preview (capped) of rows that would be backfilled." }),
  })
  .openapi("BackfillApolloPointersResponse");

registry.registerPath({
  method: "post",
  path: "/internal/backfill-apollo-audience-pointers",
  summary:
    "One-time data fix ('one filter vocabulary' Wave 2): for every apollo audience lacking apollo_audience_id, build a faithful Apollo audience via apollo-service from the row's name+description and store the pointer + cached filters + count (idempotent, dry-runnable, async)",
  security: [{ apiKey: [] }],
  request: { query: BackfillApolloPointersQuerySchema },
  responses: {
    200: { description: "Backfill result", content: { "application/json": { schema: BackfillApolloPointersResponseSchema } } },
    202: { description: "Async sweep started", content: { "application/json": { schema: BackfillApolloPointersResponseSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "apollo-service outage / missing config", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- Internal: bulk audience resolver for lead-service (by id and/or email) ---
//
// Server-to-server, service-auth, NO browser body cap (dedicated 25 MB parser).
// Resolves a batch of leads to their brand-correct active audience card, keyed by
// audienceId AND/OR email. See the "Internal bulk resolver" note in
// src/services/audiences.ts.
export const ResolveAudiencesRequestSchema = z
  .object({
    // Lax UUID SHAPE (not strict-v4): org ids can predate the v4 convention —
    // matches the header org-id parsing. But a comma-joined / doubled value must
    // still be rejected here (400) rather than pass `min(1)` and flow into a
    // uuid-typed query where Postgres crashes it with 22P02. Brand/audience ids
    // stay strict-v4 below.
    orgId: z.string().regex(LAX_UUID_REGEX, "orgId must be a valid UUID").openapi({
      description: "Org the leads belong to (internal UUID).",
    }),
    brandId: z.string().uuid().openapi({
      description:
        "Brand to resolve FOR. Only audiences of this brand are ever returned (brand-correct) — a lead is never attributed a foreign-brand audience.",
    }),
    audienceIds: z
      .array(z.string().uuid())
      .optional()
      .openapi({
        description:
          "Audience ids carried on already-tagged leads. Each resolves to its effective (deprecated->canonical) active card, or null if not this brand / retired / unknown.",
      }),
    emails: z
      .array(z.string())
      .optional()
      .openapi({
        description:
          "Lead emails (raw; normalized server-side). Each resolves to the best-status membership audience for this brand (active > paused > archived), or null. This is the HISTORICAL key — covers leads that predate audience_id tagging.",
      }),
  })
  .refine((d) => (d.audienceIds?.length ?? 0) + (d.emails?.length ?? 0) > 0, {
    message: "Provide at least one of audienceIds or emails",
  })
  .openapi("ResolveAudiencesRequest");

export const ResolvedAudienceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    avatarUrl: z.string().nullable(),
  })
  .openapi("ResolvedAudience");

export const ResolveAudiencesResponseSchema = z
  .object({
    byAudienceId: z
      .record(z.string(), ResolvedAudienceSchema.nullable())
      .openapi({
        description:
          "Map of each requested audienceId -> resolved card, or null.",
      }),
    byEmail: z
      .record(z.string(), ResolvedAudienceSchema.nullable())
      .openapi({
        description:
          "Map of each requested (raw) email -> resolved card, or null.",
      }),
  })
  .openapi("ResolveAudiencesResponse");

registry.registerPath({
  method: "post",
  path: "/internal/audiences/resolve",
  summary:
    "Server-to-server bulk resolution of leads -> brand-correct active audience {id,name,avatarUrl}, keyed by audienceId and/or email (historical coverage). No browser body cap.",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: ResolveAudiencesRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Resolution maps",
      content: {
        "application/json": { schema: ResolveAudiencesResponseSchema },
      },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
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
