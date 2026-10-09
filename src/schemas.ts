import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { LAX_UUID_REGEX } from "./lib/uuid.js";
import { SPLIT_AXES, SPLIT_ICONS } from "./lib/audience-split-vocab.js";

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
  summary: "Move every row of a brand from one org to another",
  description:
    "Fleet brand-transfer contract (orchestrated by brand-service). In ONE transaction, moves every row human-service holds for `sourceBrandId` under `sourceOrgId` to `targetOrgId`, rewriting the brand id to `targetBrandId` when given: audiences and their members / teaser buffer / screenings / screened-out rows, lead serves, brand suppressions and their recovery / backfill ledgers, brand lists and their members, solo-brand methodologies and their expert profile. Canonical people referenced only by the brand move; people the source org still uses for another brand are copied. Idempotent: a second call moves nothing and returns an empty `updatedTables`. Moves no money.",
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
  .enum(["apollo", "apify", "crm"])
  .openapi({
    description:
      "Lead provider. apollo/apify are the searchable people-gateway providers; crm is a client's uploaded contact list (served via an audience's serve-next, not searchable here).",
  });

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

export const OrganizationTechnologySchema = z
  .object({
    uid: z.string().nullable(),
    name: z.string().nullable(),
    category: z.string().nullable(),
  })
  .openapi("OrganizationTechnology");

export const OrganizationFundingEventSchema = z
  .object({
    id: z.string().nullable(),
    date: z.string().nullable(),
    type: z.string().nullable(),
    investors: z.string().nullable(),
    amount: z.number().nullable(),
    currency: z.string().nullable(),
  })
  .openapi("OrganizationFundingEvent");

export const EmploymentHistoryEntrySchema = z
  .object({
    title: z.string().nullable(),
    organizationName: z.string().nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    description: z.string().nullable(),
    current: z.boolean().nullable(),
  })
  .openapi("EmploymentHistoryEntry");

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
    providerOrganizationId: z.string().nullable().openapi({
      description: "The provider's own organization id. null when the provider serves none.",
    }),
    shortDescription: z.string().nullable(),
    seoDescription: z.string().nullable(),
    keywords: z.array(z.string()).nullable().openapi({
      description:
        "The organization's keywords as the provider serves them, in provider order. null means the provider served none — which is NOT the same claim as an empty list.",
    }),
    industries: z.array(z.string()).nullable(),
    secondaryIndustries: z.array(z.string()).nullable(),
    technologyNames: z.array(z.string()).nullable().openapi({
      description: "The organization's technology stack by name, in provider order. null when the provider serves none.",
    }),
    currentTechnologies: z.array(OrganizationTechnologySchema).nullable(),
    foundedYear: z.number().nullable(),
    annualRevenuePrinted: z.string().nullable().openapi({
      description: "Human-readable annual revenue as the provider printed it (e.g. '$12.4M'). The numeric form is `annualRevenue`.",
    }),
    totalFunding: z.string().nullable(),
    totalFundingPrinted: z.string().nullable(),
    latestFundingStage: z.string().nullable(),
    latestFundingRoundDate: z.string().nullable(),
    fundingEvents: z.array(OrganizationFundingEventSchema).nullable().openapi({
      description: "Every funding round the provider serves, in provider order. null when it serves none.",
    }),
    twitterUrl: z.string().nullable(),
    facebookUrl: z.string().nullable(),
    blogUrl: z.string().nullable(),
    crunchbaseUrl: z.string().nullable(),
    angellistUrl: z.string().nullable(),
    primaryPhone: z.string().nullable(),
    publiclyTradedSymbol: z.string().nullable(),
    publiclyTradedExchange: z.string().nullable(),
    streetAddress: z.string().nullable(),
    postalCode: z.string().nullable(),
    rawAddress: z.string().nullable(),
    numSuborganizations: z.number().nullable(),
    retailLocationCount: z.number().nullable(),
    alexaRanking: z.number().nullable(),
  })
  .openapi("NeutralOrganization");

const LinkedinEngagementEvidenceSchema = z
  .object({
    competitorPage: z.string().openapi({ description: "The competitor LinkedIn company page whose post the person engaged with." }),
    postUrl: z.string().nullable(),
    postPublishedOn: z.string().nullable().openapi({ description: "Approximate day the post was published (YYYY-MM-DD); LinkedIn only gives a relative age." }),
    kind: z.enum(["reaction", "comment"]),
    reactionType: z.string().nullable(),
    commentText: z.string().nullable(),
    commentedAt: z.string().nullable(),
  })
  .openapi("LinkedinEngagementEvidence");

export const BuyingSignalSchema = z
  .object({
    type: z.enum(["hiring", "job_change", "funding", "linkedin_engagement"]),
    occurredOn: z.string().openapi({ description: "Day the signal happened (YYYY-MM-DD), as the provider recorded it.", example: "2026-09-21" }),
    fact: z.string().openapi({
      description: "One English sentence stating the signal, for the email writer to reference.",
      example: "Acme Clinics posted a job for Office Manager (Austin, United States) on September 21, 2026",
    }),
    source: z.string().openapi({ description: "Where the evidence came from (e.g. 'apollo:job_postings').", example: "apollo:job_postings" }),
    sourceUrl: z.string().nullable().openapi({ description: "The posting or news link when the provider gives one." }),
    engagement: LinkedinEngagementEvidenceSchema.optional().openapi({
      description:
        "linkedin_engagement only (absent on the other kinds): the competitor post this person reacted to or commented on. It explains WHY this person was chosen; it is never material for the message, which must not mention it.",
    }),
  })
  .openapi("BuyingSignal");

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
    businessLanguages: z.array(z.string()).openapi({
      description:
        "Language(s) this person plausibly conducts business in, as ISO 639-1 codes (e.g. 'de', 'fr', 'it'). ORDERED, most plausible first — the ordering is a guarantee, consumers may select by position (index 0 = the single most plausible business language). An EMPTY array means UNKNOWN: we had no usable signal and deliberately do not fabricate one, which is distinct from ['en'] (= known to be English). Derived from the person's own city/state/country, falling back to their organization's; region beats country wherever a country is genuinely multilingual (Swiss cantons, Belgian regions, Canadian provinces).",
    }),
    provider: providerEnum,
    providerPersonId: z.string().nullable().openapi({
      description: "apollo person id (usable for a later enrich). null for apify.",
    }),
    organization: NeutralOrganizationSchema.nullable(),
    employmentHistory: z.array(EmploymentHistoryEntrySchema).nullable().openapi({
      description:
        "The person's FULL career history as the provider serves it — every role, in provider order (the ordering is part of the contract). `current: true` marks the role the provider flags as current. null when the provider serves no history; it is never reconstructed from the top-level organization.",
    }),
    buyingSignal: BuyingSignalSchema.nullable().openapi({
      description:
        "The buying signal this person's audience matched (the company is hiring, the person just changed jobs, the company just raised), with its date and a one-line fact the email writer can reference. Present only on a revealed person served from a buying-signal audience; null otherwise (free search teasers, apify, crm, and any person the provider holds no dated evidence for). Never defaulted or invented.",
    }),
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

export const AUDIENCE_LIST_KINDS = [
  "apollo_search",
  "apollo_buying_signal",
  "linkedin_engagement",
  "crm_contacts",
  "apify_search",
] as const;
export const AudienceListKindSchema = z.enum(AUDIENCE_LIST_KINDS);

// How a person became a member of an audience (src/services/audience-provenance.ts).
export const MembershipProvenanceSchema = z.enum(["served", "found_taken"]).openapi({
  description:
    "'served' = a serve made under this audience handed the person out. 'found_taken' = this audience's FREE search found the person while they were already taken (served) for the brand; they were not served again and nothing was paid to record it.",
});

export const AudienceChannelSchema = z
  .object({
    channel: z.enum(["cold_email"]).openapi({
      description: "The outreach channel that uses this list. cold_email is the only channel today.",
    }),
    list: AudienceListKindSchema.openapi({
        description:
          "What the list is. apollo_search: an Apollo people search. apollo_buying_signal: the same search narrowed to people showing a buying signal (see signal). linkedin_engagement: people who engaged with competitor LinkedIn posts (see signal). crm_contacts: the client's own uploaded contacts. apify_search: legacy search provider.",
      }),
    audienceId: z.string().uuid().openapi({
      description: "The audience row that holds the list (today, always the audience itself).",
    }),
    signal: z
      .object({
        type: z.string(),
        windowDays: z.number().int().nullable(),
      })
      .nullable()
      .openapi({ description: "The buying signal that narrows the list, with its rolling window. null for a plain list." }),
    size: z.number().int().nullable().openapi({
      description:
        "How many people the list holds. On the audiences LIST it is the same figure as the row's sizeCount. null ⟹ see sizeUnknownReason.",
    }),
    sizeUnknownReason: z
      .enum(["not_built_yet", "unknown_until_walked", "not_counted"])
      .nullable()
      .openapi({
        description:
          "Why size is null. not_built_yet: the list's Apollo filters are still being built. unknown_until_walked: no provider count exists for this kind (linkedin_engagement) until serving walks the whole list. not_counted: a CRM list, whose size the provider does not report here.",
      }),
  })
  .openapi("AudienceChannel");

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
    provider: z.enum(["apollo", "apify", "crm"]).nullable(),
    apolloAudienceId: z.string().nullable().openapi({
      description:
        "Pointer to the faithful Apollo audience owned by apollo-service ('one filter vocabulary' Wave 2). Set for apollo audiences; null for apify (legacy) rows and pre-Wave-2 rows not yet backfilled. The faithful filters live in apollo-service; the `filters` field below is human-service's opaque cache of them.",
    }),
    crmUploadId: z.string().nullable().openapi({
      description:
        "The ONE imported CRM source (crm-service upload id) this audience is bound to. When set, every CRM serve made under this audience is restricted to the people that came from that file, so several CRM audiences can coexist for one brand and each behaves as its own audience. null = unbound ⟹ the serve covers the brand's whole imported list (the pre-existing behaviour).",
    }),
    offerId: z.string().uuid().nullable().openapi({
      description:
        "The offer (Org > Brand > Offer > Campaign) this audience belongs to — an id owned by brand-service. An audience is assembled for one distinct thing the brand sells, so it is scoped to that offer rather than to every offer of the brand. null = no offer stated ⟹ the audience is brand-wide, the pre-existing behaviour.",
    }),
    status: AudienceStatusSchema,
    // Provenance: "brand_persona_backfill" for backfilled rows, else null.
    source: z.string().nullable(),
    profileAudienceId: z.string().uuid().nullable().openapi({
      description:
        "The client PROFILE (WHO, a cold audience the client keeps or pauses on the Targeting page) this source list was built for: a buying-signal list (hiring now, new in role, recently funded) or a competitor-post engagement list finds THAT profile's people, screened against the profile's text. Pausing or archiving the profile pauses its lists; resuming it resumes them (unless the source itself is off). null on a profile itself, on a whole-ICP list built before profiles had their own (retired once they do), and on every other audience. Show profiles = rows with null here and channels[0].list = apollo_search; sources = channels[0].list.",
    }),
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
    degraded: z.boolean().openapi({
      description:
        "The chooser's verdict on the audience it picked for this row: true when no attempt apollo-service explored really answered the request and the least-bad one was chosen anyway. INFORMATION for the customer and the dashboard — nothing here blocks, filters or warns on it, and an audience is always chosen. false for rows created before the flag existed and whenever the chooser judged the pick a genuine answer.",
    }),
    createdByUserId: z.string().uuid().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    targetText: z.string().nullable().openapi({
      description:
        "THE text of this audience: who the customer wants for THIS audience, in plain language. It is the text to show as the audience AND the text the pre-pay screen (Jev) judges every lead of every list below against, before any paid reveal. Distinct from nlPrompt, which a split shares across all its sibling audiences. null ⟹ see targetTextMissingReason.",
    }),
    targetTextOrigin: z.enum(["segment_target", "audience_target"]).nullable().openapi({
      description:
        "How targetText was written. segment_target: this audience is one of several split from one shared target, and the text was drafted for this audience alone from that target + its own segment. audience_target: the audience is not one of several, so its nlPrompt IS its text. null when targetText is null.",
    }),
    targetTextMissingReason: z.enum(["no_customer_text", "not_written_yet"]).nullable().openapi({
      description:
        "Why targetText is null. no_customer_text: the audience holds no customer text at all (no nlPrompt), so there is nothing to judge leads against. not_written_yet: the text is being drafted (it is written before the audience's first serve; until then the screen judges against nlPrompt and records that it did). null when targetText is set.",
    }),
    channels: z.array(AudienceChannelSchema).openapi({
      description:
        "The lists derived from this audience's text that a channel uses to find people, each with its own size. Every lead from every list is screened against targetText before it is used. Today every audience holds at most one list (empty for an audience with no committed provider).",
    }),
  })
  .openapi("Audience");

export const CreateAudienceRequestSchema = z
  .object({
    name: z.string().min(1),
    brandId: z.string().uuid(),
    provider: z.enum(["apollo", "apify", "crm"]).optional().openapi({
      description:
        "The provider this audience commits to. apollo/apify when persisting a candidate from /suggest; crm for a brand whose audience is its uploaded contact list (served by crm-service — no filters/apolloAudienceId, brand-scoped). Omit for a neutral audience.",
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
    crmUploadId: z.string().uuid().optional().openapi({
      description:
        "Bind this audience to ONE imported CRM source (a crm-service upload id of the same brand). Every CRM serve made under this audience is then restricted to the people of that file, so several bound audiences can coexist for one brand and each is independently pausable + independently costed. Validated against the brand's uploads at creation (400 if it is not one of them). Omit to keep the whole-brand behaviour. Immutable afterwards.",
    }),
    offerId: z.string().uuid().optional().openapi({
      description:
        "The offer this audience belongs to — a brand-service offer id. Scopes the audience to one distinct thing the brand sells; name uniqueness becomes per (org, brand, offer), so two offers of the same brand may each own an audience with the same name. Stored as-is: human-service defines no offer semantics and does not resolve the id (same as brandId). Omit to keep the brand-wide behaviour. Immutable afterwards.",
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
// PATCH only accepts metadata (name / nlPrompt); brandId, offerId and filters
// are NOT editable — re-scoping an audience to another offer is a new audience,
// since evidence attribution keys on the audience id. `.strict()` so a request
// that tries to change them fails loud (400) rather than being silently
// stripped. Status changes go through the dedicated
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
  // Narrow the list to ONE offer. Omitted = every audience of the org (or of
  // the brand when brandId is given), whatever offer they carry and including
  // the ones that carry none — the pre-offer answer, byte-identical.
  offerId: z.string().uuid().optional(),
  // Narrow the list to the source lists built for ONE client profile (their
  // profileAudienceId). Omitted = no narrowing.
  profileAudienceId: z.string().uuid().optional(),
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
  // The three figures are OMITTED (never 0) when the pool is unknown: a
  // linkedin_engagement audience has no provider count, so its pool is known only
  // once serve-next has walked it to exhaustion.
  sizeCount: z.number().int().optional().openapi({
    description:
      "Total contactable audience pool = the committed provider's count snapshot (apollo -> apolloCount, apify -> apifyCount) MINUS the people the pre-pay screen judged off target for this audience. Those people are provably not in the audience, so they leave the pool itself, not only the remaining-to-contact count. 0 for a never-counted audience. ABSENT (with availableToContactCount / availableToContactPct) for a linkedin_engagement audience whose pool is unknown: no provider count exists for it until serve-next has walked it to exhaustion, after which it is that walked pool.",
  }),
  availableToContactCount: z.number().int().optional().openapi({
    description:
      "Pool members NOT suppressed within the 3-month re-contact window (never-served, or last served >3 months ago). Computed server-side from the same per-brand cross-provider suppression the serve path enforces.",
  }),
  availableToContactPct: z.number().int().optional().openapi({
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

// Every address of a person (src/services/person-emails.ts).
export const PersonEmailSchema = z
  .object({
    email: z.string().openapi({ description: "Lower-cased address." }),
    primary: z.boolean().openapi({ description: "true for the person's primary address (= emailNorm on the other reads)." }),
    companyDomain: z.string().nullable().openapi({ description: "Company the address belongs to, when known." }),
    companyName: z.string().nullable(),
    source: z.enum(["served", "attached"]).openapi({
      description: "served = seen on a serve / reveal of this person; attached = explicitly attached by a service or staff.",
    }),
    addedAt: z.string(),
  })
  .openapi("PersonEmail");

const PersonEmailsField = z.array(PersonEmailSchema).openapi({
  description: "Every email address of the person, primary first. A lookup by ANY of them returns this person.",
});

export const AudienceMemberSchema = z
  .object({
    personId: z.string().uuid(),
    emailNorm: z.string().nullable(),
    emails: PersonEmailsField,
    linkedinUrlNorm: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    fullName: z.string().nullable(),
    companyDomain: z.string().nullable(),
    source: z.string().nullable(),
    confidence: z.string(),
    provenance: MembershipProvenanceSchema,
    joinedAt: z.string(),
    lastServedAt: z.string().openapi({
      description: "Last serve under this audience; for a 'found_taken' member, the moment it was found.",
    }),
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
          z.object({
            audienceId: z.string().uuid(),
            name: z.string(),
            provenance: MembershipProvenanceSchema.openapi({
              description: "'served' when any membership resolving to this audience was a serve, else 'found_taken'.",
            }),
          })
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
        "Natural-language audience description. Layer 1 restates it as ONE audience — the request is never split (the split is deferred to the post-validation A/B-split step). The response is still a list: an array of one.",
    }),
    brandId: z.string().uuid(),
    offerId: z.string().uuid().optional().openapi({
      description:
        "Optional offer this batch of candidates is assembled for (brand-service owns the offer entity; stored opaquely, never resolved here). Every persisted candidate carries it, so GET /orgs/audiences?offerId= returns them. Omitted ⟹ brand-wide, byte-identical to the pre-offer behaviour.",
    }),
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
        "Short human label for this audience (<=4 words), shared across providers — the layer-1 name.",
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
        "Pointer to the faithful Apollo audience apollo-service built + persisted for this audience.",
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
        "Reserved for response compatibility. Layer 1 has no hard cap, so freshly suggested candidates return false.",
    }),
    degraded: z.boolean().openapi({
      description:
        "The chooser's verdict: true when NO attempt apollo-service explored really answered the request and it picked the least-bad one anyway. INFORMATION only — a degraded audience is served, persisted and activatable exactly like any other; the customer decides whether to keep it. A candidate is always returned; this never withholds one.",
    }),
  })
  .openapi("AudienceCandidate");

export const FailedSegmentSchema = z
  .object({
    name: z.string().openapi({
      description: "The layer-1 audience name that failed to build.",
    }),
    reason: z.string().openapi({
      description: "The underlying error message (apollo-service build or chooser failure).",
    }),
  })
  .openapi("FailedSegment");

export const SuggestAudiencesResponseSchema = z
  .object({
    candidates: z.array(AudienceCandidateSchema),
    failedSegments: z.array(FailedSegmentSchema).openapi({
      description:
        "Retained for response-shape stability (the split returns later). Layer 1 emits ONE audience today, so a failed build FAILS the request LOUD (502 carrying the underlying reason) rather than returning an empty list — this array is therefore always empty on a 200.",
    }),
  })
  .openapi("SuggestAudiencesResponse");

// --- POST /orgs/audiences/{id}/serve-next ---
export const ServeNextResponseSchema = z
  .object({
    status: z.enum(["served", "exhausted", "pending"]).openapi({
      description:
        "'served' ⟹ a fresh person is returned. 'exhausted' ⟹ no new match remains for this audience within the suppression window (person is null). 'pending' ⟹ the per-call walk budget ran out before a person was found (person is null); progress is kept, so call again to continue. 'pending' is NOT exhaustion.",
    }),
    person: PersonSchema.nullable().openapi({
      description:
        "The next unserved person (real provider match on the audience's stored filters), recorded as served so the next call returns someone new. null when exhausted.",
    }),
    personId: z.string().uuid().optional().openapi({
      description:
        "human-service's canonical person id for the served person: the same `personId` GET /orgs/audiences/{id}/members returns for them. Durable across providers (never a provider id). Present on every 'served' answer; omitted when 'exhausted'.",
    }),
  })
  .openapi("ServeNextResponse");

// --- Candidate API (lead-service qualifies before the paid reveal) ---
const ScreenTargetSchema = z
  .object({
    text: z.string(),
    field: z.enum(["target_text", "nl_prompt"]),
  })
  .nullable()
  .openapi({
    description:
      "The audience's own text: who the client wants for THIS audience, the text the pre-pay screen judges every candidate against (`targetText`, else the shared `nlPrompt`). null when the audience has neither.",
  });

export const AudienceCandidateViewSchema = z
  .object({
    candidateId: z.string().uuid().openapi({ description: "Handle for reveal / decline." }),
    audienceId: z.string().uuid(),
    providerPersonId: z.string().openapi({ description: "Apollo person id (the reveal handle)." }),
    linkedinUrl: z.string().nullable(),
    offeredAt: z.string().openapi({ description: "ISO time the candidate was (last) offered. An undecided offer is offered again after 15 minutes." }),
    person: z.object({
      name: z.string().nullable(),
      title: z.string().nullable(),
      headline: z.string().nullable(),
      seniority: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      country: z.string().nullable(),
    }),
    company: z.object({
      name: z.string().nullable(),
      domain: z.string().nullable().openapi({
        description:
          "Employer web domain as the provider served it on the free teaser. null when the provider served none (never guessed).",
      }),
      industry: z.string().nullable(),
      employees: z.number().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      country: z.string().nullable(),
      keywords: z.array(z.string()).nullable(),
    }),
  })
  .openapi("AudienceCandidateView");

export const NextCandidateResponseSchema = z
  .object({
    status: z.enum(["candidate", "exhausted", "pending"]).openapi({
      description:
        "'candidate' ⟹ a free candidate, every free check applied (brand suppression, opt-outs, won people, own company, hard bounces, people already rejected for this audience); nothing billed. 'exhausted' ⟹ none left (`reason`). 'pending' ⟹ the per-call walk budget ran out; call again.",
    }),
    candidate: AudienceCandidateViewSchema.nullable(),
    reason: z.enum(["pool_exhausted", "yield_exhausted"]).optional().openapi({
      description:
        "On 'exhausted' only. pool_exhausted = the provider has nobody new. yield_exhausted = over the last 1,000 decisions under the latest `basis`, fewer than 3 were reveals.",
    }),
    target: ScreenTargetSchema,
  })
  .openapi("NextCandidateResponse");

export const RevealCandidateRequestSchema = z
  .object({
    basis: z.string().min(1).max(200).optional().openapi({
      description:
        "Name of the question your qualification asked (e.g. a criteria version). The yield window is keyed on the latest basis: a new basis starts a new window.",
    }),
  })
  .strict()
  .openapi("RevealCandidateRequest");

export const RevealCandidateResponseSchema = z
  .object({
    status: z.enum(["served", "not_served"]).openapi({
      description:
        "'served' ⟹ the same served person serve-next returns, recorded as served. 'not_served' ⟹ the reveal ran (billed) but nobody servable came out (no usable / deliverable email, or blocked after the reveal); ask for the next candidate.",
    }),
    person: PersonSchema.nullable(),
    personId: z.string().uuid().optional().openapi({
      description: "Canonical human-service person id, present on 'served' (same as serve-next).",
    }),
    reason: z
      .enum([
        "provider_skipped",
        "no_person",
        "no_email",
        "opted_out",
        "won",
        "already_served",
        "own_company",
        "bounced",
        "not_deliverable",
      ])
      .optional()
      .openapi({
        description:
          "On every 'not_served'. provider_skipped = the provider declined to buy the reveal (its mail domain cannot verify; NO credit spent). Every other reason comes after a bought reveal: no_person / no_email = the provider returned nobody / no address; not_deliverable = the address failed verification (see verdict); opted_out / won / already_served / own_company / bounced = a gate after the reveal.",
      }),
    verdict: z.string().optional().openapi({
      description: "not_deliverable only: the verification verdict (catch_all, unknown, invalid, risky).",
    }),
    detail: z.string().optional().openapi({
      description: "provider_skipped only: the provider's reason (catch_all_domain, checker_blocked_domain).",
    }),
    replayed: z.boolean().openapi({
      description: "true ⟹ this candidate was already revealed; the stored answer is returned and nothing is billed again.",
    }),
  })
  .openapi("RevealCandidateResponse");

export const DeclineCandidateRequestSchema = z
  .object({
    reason: z.string().min(1).max(2000).openapi({
      description: "Why the candidate was declined (prose, stored for audit).",
    }),
    basis: z.string().min(1).max(200).optional().openapi({
      description: "Same as on reveal.",
    }),
  })
  .strict()
  .openapi("DeclineCandidateRequest");

export const DeclineCandidateResponseSchema = z
  .object({
    declined: z.literal(true),
    replayed: z.boolean(),
  })
  .openapi("DeclineCandidateResponse");

export const ListScreeningsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  providerPersonId: z.string().min(1).optional(),
});

export const ListScreeningsResponseSchema = z
  .object({
    screenings: z.array(
      z.object({
        id: z.string().uuid(),
        providerPersonId: z.string(),
        linkedinUrl: z.string().nullable(),
        teaser: z.record(z.string(), z.unknown()).openapi({ description: "The snapshot the verdict was judged on." }),
        verdict: z.boolean().openapi({ description: "true = on target (revealed), false = rejected." }),
        yesProbability: z.number().nullable(),
        targetText: z.string().nullable(),
        targetField: z.string().nullable(),
        reason: z.string().nullable(),
        model: z.string(),
        promptVersion: z.string(),
        createdAt: z.string(),
      })
    ),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi("ListScreeningsResponse");

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

export const CreateLinkedinEngagementAudienceRequestSchema = z
  .object({
    brandId: z.string().uuid(),
    offerId: z.string().uuid().optional().openapi({
      description: "The brand-service offer this audience belongs to. Stored verbatim, like brandId. Omitted = brand-wide.",
    }),
    name: z.string().trim().min(1).max(200).optional().openapi({
      description: "Audience name (English), unique per (brand, offer). Omitted = apollo-service's label (competitor slugs + window).",
    }),
    nlPrompt: z.string().trim().min(1).openapi({
      description:
        "Who among the engagers is worth writing to, in plain English (people, not only companies). Stored as the audience target: the pre-pay screen judges every engager teaser (name, title, headline, employer) against it before any email is paid for.",
    }),
    status: z.enum(["active", "paused"]).optional().openapi({
      description: "Initial status. Omitted = active.",
    }),
    signal: z
      .object({
        type: z.literal("linkedin_engagement"),
        windowDays: z.number().int().min(1).max(365).openapi({
          description: "Age of the competitor posts whose engagers are served, in days, counted back from each serve (rolling).",
        }),
        competitorPages: z.array(z.string()).openapi({
          description: "1-3 competitor LinkedIn company page URLs (https://www.linkedin.com/company/<slug>/). Validated by apollo-service, whose named 400 is relayed.",
        }),
      })
      .strict(),
    filters: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        "Apollo base filters. Must be empty: apollo-service refuses Apollo filters beside this signal with a named 400 (relayed), since its people are LinkedIn engagers, not an Apollo search. Omitted = {}.",
    }),
  })
  .strict()
  .openapi("CreateLinkedinEngagementAudienceRequest");

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/signal",
  summary:
    "Create a linkedin_engagement signal audience: people who recently reacted to or commented on 1-3 competitor LinkedIn company pages' posts",
  description:
    "Persists the criterion on apollo-service and stores a servable apollo pointer audience. No size estimate exists for this kind (no Apollo count): Size / Remaining are omitted from the list until a serve walks the pool. Served by serve-next like any apollo audience (engager teasers screened before the paid reveal). apollo-service's 4xx (malformed competitor pages, Apollo filters beside the signal) is relayed with its status and body.",
  security: [{ apiKey: [] }],
  request: {
    headers: peopleHeaders,
    body: { content: { "application/json": { schema: CreateLinkedinEngagementAudienceRequestSchema } } },
  },
  responses: {
    201: { description: "Audience created", content: { "application/json": { schema: GetAudienceResponseSchema } } },
    400: { description: "Invalid request (ours or apollo-service's, relayed)", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    409: { description: "An audience with this name already exists for this brand and offer", content: { "application/json": { schema: ErrorSchema } } },
    502: { description: "apollo-service failed", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/audiences",
  summary: "List audiences for an org (optional brandId / offerId filter)",
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

export const AudiencePreviewResponseSchema = z
  .object({
    audienceId: z.string().uuid(),
    status: z
      .enum(["ready", "empty", "unavailable"])
      .describe(
        "ready = real rows below. empty = the provider's search matched nobody (reason no_match); final for this audience. unavailable = no sample can be taken right now: reason not_built_yet (the audience's provider-side filters are still being built; ask again shortly) or provider_not_previewable (a CRM-upload or retired apify audience has no free search to sample)."
      ),
    reason: z.enum(["no_match", "not_built_yet", "provider_not_previewable"]).nullable(),
    matchCount: z
      .number()
      .int()
      .nullable()
      .describe("The provider's live match count (people with a verified email) at the moment the sample was taken. Null when unavailable."),
    companies: z
      .array(
        z.object({
          name: z.string(),
          peopleInSample: z
            .number()
            .int()
            .describe("How many of the provider's first page of matching people work there. A share of the sample, not a headcount."),
        })
      )
      .describe("Up to ~10 real employers of people who match the audience, in the provider's order. Name only: descriptors (domain, industry, size) would need a paid company search."),
    people: z
      .array(
        z.object({
          firstName: z.string().nullable(),
          lastNameObfuscated: z.string().nullable().describe("Masked by the provider's free search, e.g. \"Ni***s\"."),
          title: z.string().nullable(),
          company: z.string().nullable().describe("Always one of the listed companies."),
        })
      )
      .describe("Up to ~20 real people who match the audience, as the provider's free search serves them. Never an email, a phone, a location or a photo."),
    generatedAt: z.string().nullable().describe("When the sample was taken (ISO 8601). Null when unavailable."),
  })
  .openapi("AudiencePreviewResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/audiences/{id}/preview",
  summary:
    "A free sample of who an audience reaches: up to ~10 real companies and ~20 real people, never an email or a phone. Taken once and stored, so repeat calls cost no provider spend.",
  security: [{ apiKey: [] }],
  request: { headers: peopleHeaders, params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Sample (or an honest empty/unavailable answer with a reason)", content: { "application/json": { schema: AudiencePreviewResponseSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export const AudiencePreviewEmailChecksResponseSchema = z
  .object({
    audienceId: z.string().uuid(),
    status: z
      .enum(["ready", "unavailable"])
      .describe("ready = `people` below. unavailable = no check can run for this audience; see `reason`."),
    reason: z
      .enum(["no_match", "not_built_yet", "provider_not_previewable", "empty_sample", "no_reveal_handle"])
      .nullable()
      .describe(
        "Why unavailable. The preview's own reasons (no_match, not_built_yet: ask again shortly, provider_not_previewable), empty_sample (the preview holds no people), no_reveal_handle (the provider did not identify the sampled people, so none can be revealed)."
      ),
    done: z.boolean().describe("True when every checked person is settled (found or not_found), or when unavailable. Stop calling /next."),
    people: z
      .array(
        z.object({
          index: z.number().int().describe("Position of this person in the preview's `people` array."),
          firstName: z.string().nullable(),
          lastNameObfuscated: z.string().nullable(),
          title: z.string().nullable(),
          company: z.string().nullable(),
          status: z
            .enum(["pending", "checking", "found", "not_found"])
            .describe("pending = not attempted yet. checking = a reveal is running now (another call). found = an email came back. not_found = the finder ran and returned no email."),
          finder: z.string().nullable().describe("The finder that ran (today always \"apollo\"). Null until settled."),
          verifier: z.string().nullable().describe("The verifier that judged the found address, as the provider names it (e.g. \"bounceverify\"). Null unless found."),
          verdict: z
            .enum(["valid", "catch_all", "invalid", "risky", "unknown"])
            .nullable()
            .describe("The verifier's verdict on the found address. Null unless found."),
          deliverable: z.boolean().nullable().describe("True only for verdict valid. Null unless found."),
          maskedEmail: z.string().nullable().describe("The found address's domain behind a masked local part, e.g. \"***@acme.com\". The address itself is never returned."),
          checkedAt: z.string().nullable().describe("When the outcome came back (ISO 8601). Null until settled."),
        })
      )
      .describe("The first few people of the preview (at most 5), in preview order. Only real attempts and real outcomes: nothing is marked found or not_found until the finder answered."),
    summary: z.object({
      checked: z.number().int(),
      found: z.number().int(),
      deliverable: z.number().int(),
    }),
  })
  .openapi("AudiencePreviewEmailChecksResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/audiences/{id}/preview/email-checks",
  summary:
    "Where the email check of an audience preview stands: for its first people, whether a deliverable email was found and verified, by which finder. Free, never runs a reveal, never returns an address.",
  security: [{ apiKey: [] }],
  request: { headers: peopleHeaders, params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Current state", content: { "application/json": { schema: AudiencePreviewEmailChecksResponseSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/{id}/preview/email-checks/next",
  summary:
    "Check ONE more person of an audience preview: run the provider's billed email reveal + verification for the next pending person (cost declared by apollo-service against the caller's org, ~12 cents), store the outcome, return the whole state. Call in a loop until done. At most 5 reveals per audience ever; spends nothing once done. Not a serve: nobody becomes a lead. Never returns an address.",
  security: [{ apiKey: [] }],
  request: { headers: peopleHeaders, params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "State after this check", content: { "application/json": { schema: AudiencePreviewEmailChecksResponseSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider or verification error; nothing stored for that person, the next call retries it", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export const PreviewCompaniesQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).optional().describe("0-based index of the first row to return. Default 0."),
  limit: z.coerce.number().int().min(1).max(100).optional().describe("Rows to return, 1-100. Default 25."),
});

const PreviewCompanyRowEmailCheckSchema = z
  .object({
    index: z.number().int().describe("The company row's index."),
    status: z
      .enum(["pending", "checking", "found", "not_found"])
      .describe("pending = not attempted yet. checking = a reveal is running now (another call). found = an email came back. not_found = the finder ran and returned no email."),
    finder: z.string().nullable().describe("The finder that ran (today always \"apollo\"). Null until settled."),
    verifier: z.string().nullable().describe("The verifier that judged the found address (e.g. \"bounceverify\"). Null unless found."),
    verdict: z.enum(["valid", "catch_all", "invalid", "risky", "unknown"]).nullable().describe("The verifier's verdict. Null unless found."),
    deliverable: z.boolean().nullable().describe("True only for verdict valid. Null unless found."),
    maskedEmail: z.string().nullable().describe("e.g. \"***@acme.com\". The address itself is never returned."),
    checkedAt: z.string().nullable().describe("When the outcome came back (ISO 8601). Null until settled."),
  })
  .openapi("PreviewCompanyRowEmailCheck");

export const AudiencePreviewCompaniesResponseSchema = z
  .object({
    audienceId: z.string().uuid(),
    status: z
      .enum(["ready", "empty", "unavailable"])
      .describe("ready = rows below (possibly more to page). empty = the audience matched nobody (reason no_match). unavailable = reason not_built_yet (ask again shortly) or provider_not_previewable (CRM-upload / retired apify audience)."),
    reason: z.enum(["no_match", "not_built_yet", "provider_not_previewable"]).nullable(),
    rows: z
      .array(
        z.object({
          index: z.number().int().describe("Stable 0-based rank of the company in this audience's list. Never changes once built."),
          company: z.object({
            name: z.string(),
            domain: z.string().nullable(),
            website: z.string().nullable(),
            logoUrl: z.string().nullable(),
            description: z.string().nullable().describe("One line, as the provider describes the company."),
            location: z.string().nullable().describe("Display string, e.g. \"Zurich, Switzerland\"."),
            city: z.string().nullable(),
            country: z.string().nullable(),
            employeeCount: z.number().int().nullable(),
            industry: z.string().nullable(),
            linkedinUrl: z.string().nullable(),
            foundedYear: z.number().int().nullable(),
          }),
          person: z
            .object({
              firstName: z.string().nullable(),
              lastNameObfuscated: z.string().nullable().describe("Masked by the provider, e.g. \"Ni***s\". The full name is revealed only after signup."),
              title: z.string().nullable(),
              linkedinUrl: z.string().nullable().describe("Only when the provider gives it without a reveal; usually null."),
            })
            .describe("The one person of the audience to write to at this company. Never an email or a phone."),
        })
      )
      .describe("The requested page of rows, in index order. A field the provider does not give is null, never invented."),
    totalAvailable: z.number().int().describe("Rows built and stored so far for this audience (grows as callers page)."),
    nextOffset: z.number().int().nullable().describe("Offset of the next page; null when there is nothing more to ask for."),
    done: z.boolean().describe("True once the list is complete (maxRows reached, or the audience ran out of companies)."),
    maxRows: z.number().int().describe("The list's ceiling (100)."),
  })
  .openapi("AudiencePreviewCompaniesResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/audiences/{id}/preview/companies",
  summary:
    "Up to 100 real companies an audience reaches, with firmographics, and the one person to write to at each (masked name + title, never an email or a phone). Built progressively: each call builds only as far as offset+limit needs, so the first page comes back in seconds; rows are stored once per audience, so a repeat read costs nothing. The company data is a paid provider call, declared by apollo-service against the caller's org.",
  security: [{ apiKey: [] }],
  request: { headers: peopleHeaders, params: z.object({ id: z.string().uuid() }), query: PreviewCompaniesQuerySchema },
  responses: {
    200: { description: "A page of rows (or an honest empty/unavailable answer)", content: { "application/json": { schema: AudiencePreviewCompaniesResponseSchema } } },
    400: { description: "Invalid offset/limit", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider error (nothing stored for the failed chunk)", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export const AudiencePreviewCompaniesEmailChecksResponseSchema = z
  .object({
    audienceId: z.string().uuid(),
    maxCheckable: z.number().int().describe("Only rows with index below this can be email-checked (10)."),
    checks: z.array(PreviewCompanyRowEmailCheckSchema).describe("One per built row with index < maxCheckable, in index order."),
  })
  .openapi("AudiencePreviewCompaniesEmailChecksResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/audiences/{id}/preview/companies/email-checks",
  summary: "Where the email check of each checkable company row stands (found / verified, by which finder). Free, never runs a reveal, never returns an address.",
  security: [{ apiKey: [] }],
  request: { headers: peopleHeaders, params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "Current state", content: { "application/json": { schema: AudiencePreviewCompaniesEmailChecksResponseSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/{id}/preview/companies/{index}/email-check",
  summary:
    "Check whether the person on ONE company row can be reached: runs the provider's billed email reveal + verification (cost declared by apollo-service against the caller's org, ~12 cents), stores the outcome, returns it. Idempotent: a settled row spends nothing. Only the first 10 rows are checkable. Not a serve: nobody becomes a lead. Never returns an address.",
  security: [{ apiKey: [] }],
  request: {
    headers: peopleHeaders,
    params: z.object({ id: z.string().uuid(), index: z.coerce.number().int().min(0) }),
  },
  responses: {
    200: { description: "This row's check", content: { "application/json": { schema: PreviewCompanyRowEmailCheckSchema } } },
    400: { description: "Index not checkable (>= 10) or invalid", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Audience not found, or the row is not built yet", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "The row carries no reveal handle", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider or verification error; nothing stored, the next call retries", content: { "application/json": { schema: ErrorSchema } } },
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
  path: "/orgs/audiences/{id}/candidates/next",
  summary:
    "Next FREE candidate of an apollo audience (who + company, every free check applied), before any reveal is bought",
  description:
    "For lead-service's pre-pay qualification. Nothing is screened and nothing is billed. Each person is offered once per audience; an offer not decided within 15 minutes is offered again. serve-next is unchanged.",
  security: [{ apiKey: [] }],
  request: { headers: peopleHeaders, params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { description: "A candidate, exhausted or pending", content: { "application/json": { schema: NextCandidateResponseSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Not an apollo audience (use serve-next), or no stored filters", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider or gate source error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/{id}/candidates/{candidateId}/reveal",
  summary: "Reveal (billed) an offered candidate, recorded as served exactly as serve-next. Billed once.",
  security: [{ apiKey: [] }],
  request: {
    headers: peopleHeaders,
    params: z.object({ id: z.string().uuid(), candidateId: z.string().uuid() }),
    body: { content: { "application/json": { schema: RevealCandidateRequestSchema } } },
  },
  responses: {
    200: { description: "Served person, or not_served", content: { "application/json": { schema: RevealCandidateResponseSchema } } },
    400: { description: "Invalid body", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Audience or candidate not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Candidate declined, or a reveal is in progress", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Not an apollo audience", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "Provider error; nothing recorded, the candidate can be revealed again", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/{id}/candidates/{candidateId}/decline",
  summary:
    "Decline an offered candidate: never offered or served again for this audience, and the audience Size drops by one (same as a screen rejection)",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    params: z.object({ id: z.string().uuid(), candidateId: z.string().uuid() }),
    body: { content: { "application/json": { schema: DeclineCandidateRequestSchema } } },
  },
  responses: {
    200: { description: "Declined (idempotent)", content: { "application/json": { schema: DeclineCandidateResponseSchema } } },
    400: { description: "Invalid body", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Audience or candidate not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Candidate already revealed / being revealed", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

export const AudienceSourcingOriginResponseSchema = z
  .object({
    audienceId: z.string().uuid(),
    list: AudienceListKindSchema.openapi({
      description:
        "The list a serve-next of this audience draws from under the request's x-feature-slug: crm_contacts when it names the CRM outreach channel (sales-crm-email-outreach) or the CRM origin (sourcing-crm-contacts), whatever the audience's provider; else the audience's own list (channels[].list).",
    }),
    sourcingFeatureSlug: z.string().openapi({
      description:
        "features-service sourcing origin slug of that list (e.g. sourcing-apollo-cold-filters). Open the serve run under it and send it as x-feature-slug on serve-next: serve-next serves the same person under it as under the outreach channel slug.",
    }),
  })
  .openapi("AudienceSourcingOriginResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/audiences/{id}/sourcing-origin",
  summary: "Sourcing origin (features-service slug) a serve-next of this audience draws from",
  description:
    "Send the x-feature-slug you would send to serve-next today (the outreach channel). Read from features-service's /public/sourcing-origins catalogue (cached 10 min). 502 when features-service cannot name it, never a fallback.",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders.extend({
      "x-feature-slug": z.string().optional().openapi({
        description: "The campaign's outreach channel slug, exactly as sent to serve-next today (sales-crm-email-outreach routes to the client's CRM).",
      }),
    }),
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: "Origin of the list served", content: { "application/json": { schema: AudienceSourcingOriginResponseSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Audience has no committed provider (serves from no list)", content: { "application/json": { schema: ErrorSchema } } },
    502: { description: "features-service unreachable or names no origin for the list", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/audiences/{id}/screenings",
  summary: "Past pre-pay screen verdicts of an audience (bronze, every verdict, oldest first)",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    params: z.object({ id: z.string().uuid() }),
    query: ListScreeningsQuerySchema,
  },
  responses: {
    200: { description: "Verdicts page (limit default 100, max 1000)", content: { "application/json": { schema: ListScreeningsResponseSchema } } },
    400: { description: "Invalid query", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Audience not found", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
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

// --- Internal: one-time backfill of per-audience target texts (pre-0033 rows) ---
export const BackfillAudienceTargetTextsQuerySchema = z.object({
  dryRun: z.enum(["true", "false"]).optional().openapi({
    description: "When 'true', classify every audience without a text and write/draft nothing. Defaults to false.",
  }),
  async: z.enum(["true", "false"]).optional().openapi({
    description: "When 'true', answer 202 at once and run the sweep in the background (each segment target is one LLM call).",
  }),
  brandId: z.string().uuid().optional().openapi({ description: "Narrow the sweep to one brand." }),
});

export const BackfillAudienceTargetTextsResponseSchema = z
  .object({
    dryRun: z.boolean(),
    scanned: z.number().int(),
    audienceTarget: z.number().int().openapi({ description: "Audiences not one of several: their nlPrompt copied as their text." }),
    segmentTarget: z.number().int().openapi({ description: "Audiences one of several sharing an nlPrompt: a text drafted for each (0 written on a dry-run)." }),
    noCustomerText: z.number().int().openapi({ description: "Audiences with no nlPrompt: no text exists, served as null with reason no_customer_text." }),
    failed: z.array(z.object({ audienceId: z.string(), error: z.string() })),
    sample: z.array(
      z.object({
        audienceId: z.string(),
        name: z.string(),
        origin: z.enum(["segment_target", "audience_target"]),
        targetText: z.string().nullable(),
      })
    ),
  })
  .openapi("BackfillAudienceTargetTextsResponse");

registry.registerPath({
  method: "post",
  path: "/internal/backfill-audience-target-texts",
  summary:
    "One-time data fix: write every pre-existing audience's own text (targetText): its nlPrompt when it is not one of several, else a segment target drafted from the shared nlPrompt + its own segment (idempotent, dry-runnable)",
  security: [{ apiKey: [] }],
  request: { query: BackfillAudienceTargetTextsQuerySchema },
  responses: {
    200: { description: "Backfill result", content: { "application/json": { schema: BackfillAudienceTargetTextsResponseSchema } } },
    202: { description: "Accepted (async=true): the sweep runs in the background and logs its result" },
    401: { description: "Unauthorized" },
  },
});

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
  profilesOnly: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', only CLIENT PROFILES (cold Apollo search audiences that are not a profile's source list), non-archived. Source lists show their profile's avatar, so they need none.",
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

// --- Internal: one-time attribution of pre-existing audiences to their offer ---
// #221 gave the row its offer grain and #223 let a suggestion state it, so every
// audience born after those carries an offer. Rows created before them carry
// none, and the customer Audiences page now asks for one offer's audiences — so
// they are invisible there. An offer is per (org, brand) and an audience already
// carries both, so brand-service resolves the pair and, where exactly one offer
// exists, there is one correct answer. Where none exists the row stays NULL and
// the count is reported.
export const BackfillAudienceOffersQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', resolve which audiences would be attributed to which offer + return the full mapping and the unattributed count WITHOUT writing. Defaults to false (real run).",
    }),
});

export const BackfillAudienceOffersResponseSchema = z
  .object({
    dryRun: z.boolean(),
    scanned: z.number().int().openapi({
      description: "Audiences with offer_id IS NULL inspected by this sweep.",
    }),
    pairs: z.number().int().openapi({
      description:
        "Distinct (org, brand) pairs those audiences span — one brand-service offer read each.",
    }),
    attributed: z.number().int().openapi({
      description:
        "Audiences given their offer (0 on a dry-run; the would-be count is `wouldAttribute`).",
    }),
    wouldAttribute: z.number().int().openapi({
      description: "Audiences whose (org, brand) resolves to exactly one offer.",
    }),
    unattributed: z.number().int().openapi({
      description:
        "Audiences still carrying no offer after this sweep — their (org, brand) holds none, or holds several so there is no single correct answer. Reported, never guessed: absent means brand-wide, which is what the column documents.",
    }),
    skipped: z
      .array(
        z.object({
          orgId: z.string(),
          brandId: z.string(),
          audiences: z.number().int(),
          reason: z.string(),
        })
      )
      .openapi({
        description:
          "One entry per (org, brand) pair left alone, with how many audiences it costs: 'no offer', 'several offers (N)', or a brand-service read failure (retried on re-run).",
      }),
    assignments: z
      .array(
        z.object({
          audienceId: z.string(),
          name: z.string(),
          orgId: z.string(),
          brandId: z.string(),
          offerId: z.string(),
        })
      )
      .openapi({
        description:
          "The FULL mapping written (or that would be written) — not a sample, because it is the reversal set: undo with UPDATE audiences SET offer_id = NULL WHERE id IN (these ids). Also logged per row.",
      }),
  })
  .openapi("BackfillAudienceOffersResponse");

registry.registerPath({
  method: "post",
  path: "/internal/backfill-audience-offers",
  summary:
    "One-time data fix: attribute every pre-existing offer-less audience to the offer its (org, brand) holds, read from brand-service. A pair with no offer — or with several — is left NULL and reported, never guessed (idempotent, dry-runnable, reversible)",
  security: [{ apiKey: [] }],
  request: { query: BackfillAudienceOffersQuerySchema },
  responses: {
    200: { description: "Attribution result", content: { "application/json": { schema: BackfillAudienceOffersResponseSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "brand-service missing config", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- Internal: audience refill (human-service#285) ---
export const AudienceRefillQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', measure pools, read billing and report who would be refilled WITHOUT spending or writing. Defaults to false (real run).",
    }),
  brandId: z.string().uuid().optional().openapi({ description: "Only this brand." }),
});

export const WideningProposalSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string(),
    brandId: z.string().uuid(),
    offerId: z.string().uuid(),
    status: z.enum(["pending", "accepted", "declined"]),
    baseTarget: z.string().openapi({ description: "The target the client validated, verbatim (the one with nobody new left)." }),
    widenedTarget: z
      .string()
      .openapi({ description: "The wider target the accepted audiences would be screened against (their nl_prompt)." }),
    segments: z
      .array(
        z.object({
          name: z.string(),
          description: z.string(),
          icon: z.string().nullable(),
          estimatedLeadCount: z.number().int().nullable(),
        })
      )
      .openapi({ description: "The audiences accepting would create, in order. Nothing in them is contacted while pending." }),
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
    createdAudienceIds: z
      .array(z.string().uuid())
      .openapi({ description: "Audiences created by the accept (empty unless accepted)." }),
  })
  .openapi("AudienceWideningProposal");

const RefillOutcomeSchema = z.object({
  orgId: z.string(),
  brandId: z.string(),
  remaining: z.number().int(),
  dailyPace: z.number(),
  billingState: z.string().nullable(),
  action: z.enum(["refilled", "widening_proposed", "would_refill", "skipped"]).openapi({
    description:
      "refilled: new ACTIVE audiences INSIDE the target the client validated (`created`, non-empty; screening target unchanged). widening_proposed: nobody new is left inside that target; NOTHING was created and a widening proposal waits for the client (`proposal`, status pending; read / accept / decline under /orgs/audiences/widening-proposals). would_refill: dry run, the brand passes every guard. skipped: nothing could be done, `reason` + `detail` say why.",
  }),
  reason: z.string().nullable().openapi({
    description:
      "Set when skipped: not_low | unmeasurable | cooldown | not_chargeable | billing_unreadable | no_offer | no_target | no_user | widening_declined (nobody new inside the target and the client already declined widening it) | nothing_left (nobody new inside the target, nobody close outside it) | failed.",
  }),
  detail: z.string().nullable(),
  created: z.array(
    z.object({ id: z.string().uuid(), name: z.string(), description: z.string().nullable() })
  ),
  proposal: WideningProposalSchema.nullable().openapi({
    description: "The pending widening proposal when action=widening_proposed, else null.",
  }),
});

export const AudienceRefillResponseSchema = z
  .object({
    dryRun: z.boolean(),
    scanned: z.number().int(),
    low: z.number().int(),
    refilled: z.number().int(),
    proposed: z.number().int().openapi({ description: "Brands answered with a pending widening proposal." }),
    outcomes: z.array(RefillOutcomeSchema),
  })
  .openapi("AudienceRefillResponse");

registry.registerPath({
  method: "post",
  path: "/internal/audience-refill",
  summary:
    "Run the audience refill now: every brand served in the last 14 days whose people left to contact across its active audiences cover less than 7 days of its own pace, and whose billing can charge it (will_charge / charge_due_now), gets NEW active audiences INSIDE the target the client validated (split + Apollo build, org-billed; screening target unchanged). When nobody new is left inside that target, it creates NO audience: it stores a widening proposal for the client to accept or decline (action=widening_proposed). Never edits an audience, never starts a campaign. At most once per brand per 3 days.",
  security: [{ apiKey: [] }],
  request: { query: AudienceRefillQuerySchema },
  responses: {
    200: { description: "Refill result", content: { "application/json": { schema: AudienceRefillResponseSchema } } },
    401: { description: "Unauthorized" },
    409: { description: "Already running or migrations not ready", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- Org-scoped: audience widening proposals (the refill's "nothing left inside your target") ---
export const ListWideningProposalsQuerySchema = z.object({
  brandId: z.string().uuid().optional().openapi({ description: "Only this brand." }),
  status: z
    .enum(["pending", "accepted", "declined"])
    .optional()
    .openapi({ description: "Only this status. Omitted = every status, newest first (max 100)." }),
});

export const WideningProposalIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const ListWideningProposalsResponseSchema = z
  .object({ proposals: z.array(WideningProposalSchema) })
  .openapi("ListAudienceWideningProposalsResponse");

export const WideningProposalResponseSchema = z
  .object({ proposal: WideningProposalSchema })
  .openapi("AudienceWideningProposalResponse");

export const AcceptWideningProposalResponseSchema = z
  .object({
    proposal: WideningProposalSchema,
    audiences: z.array(AudienceSchema).openapi({
      description:
        "The ACTIVE audiences the accept created (same ones on a repeated accept), in the proposal's segment order, nl_prompt = widenedTarget, source = widening_accepted. Apollo filters are built in the background.",
    }),
  })
  .openapi("AcceptAudienceWideningProposalResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/audiences/widening-proposals",
  summary:
    "List the org's audience widening proposals: when the refill finds nobody new inside the target a client validated, it stores the wider target + the segments it would add here instead of contacting them. Pending ones wait for the client's accept / decline.",
  security: [{ apiKey: [] }],
  request: { headers: orgsListsHeaders, query: ListWideningProposalsQuerySchema },
  responses: {
    200: { description: "Proposals, newest first", content: { "application/json": { schema: ListWideningProposalsResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/audiences/widening-proposals/{id}",
  summary: "Get one audience widening proposal of the org",
  security: [{ apiKey: [] }],
  request: { headers: orgsListsHeaders, params: WideningProposalIdParamsSchema },
  responses: {
    200: { description: "The proposal", content: { "application/json": { schema: WideningProposalResponseSchema } } },
    401: { description: "Unauthorized" },
    404: { description: "No such proposal for this org", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/widening-proposals/{id}/accept",
  summary:
    "Accept a widening proposal on the client's behalf: its segments become ACTIVE audiences under the offer (all or nothing), screened against the wider target, so the brand's target widens. Existing audiences are never edited. Idempotent: a repeated accept returns the same audiences. 409 when already declined.",
  security: [{ apiKey: [] }],
  request: { headers: orgsListsHeaders, params: WideningProposalIdParamsSchema },
  responses: {
    200: { description: "Accepted", content: { "application/json": { schema: AcceptWideningProposalResponseSchema } } },
    401: { description: "Unauthorized" },
    404: { description: "No such proposal for this org", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Already declined", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/widening-proposals/{id}/decline",
  summary:
    "Decline a widening proposal on the client's behalf: nothing is created and no target changes; the refill never re-proposes widening that same target. Idempotent. 409 when already accepted.",
  security: [{ apiKey: [] }],
  request: { headers: orgsListsHeaders, params: WideningProposalIdParamsSchema },
  responses: {
    200: { description: "Declined", content: { "application/json": { schema: WideningProposalResponseSchema } } },
    401: { description: "Unauthorized" },
    404: { description: "No such proposal for this org", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Already accepted", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- Internal: competitor-engagement audience sweep ---
export const CompetitorEngagementSweepQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .openapi({ description: "When 'true', read billing and report WITHOUT creating or spending. Defaults to false." }),
  brandId: z.string().uuid().optional().openapi({ description: "Only this brand." }),
});

export const CompetitorEngagementSweepResponseSchema = z
  .object({
    dryRun: z.boolean(),
    scanned: z.number().int(),
    created: z.number().int(),
    entries: z.array(
      z.object({
        orgId: z.string(),
        brandId: z.string(),
        offerId: z.string().nullable(),
        action: z.enum(["created", "exists", "no_pages", "not_computed", "failed", "would_ensure", "skipped"]),
        reason: z.string().nullable(),
        audienceId: z.string().nullable(),
        pages: z.array(z.string()),
      })
    ),
  })
  .openapi("CompetitorEngagementSweepResponse");

registry.registerPath({
  method: "post",
  path: "/internal/competitor-engagement-audiences",
  summary:
    "Run the competitor-engagement sweep now: every brand with an active audience and no linkedin_engagement audience on its main offer, whose billing can charge it, gets one active audience of the people who recently engaged with up to 3 competitor LinkedIn company pages (pages from brand-service). Free to create: no count, no harvest, no reveal. Spend only happens when a campaign serves it. Also runs every 6 hours.",
  security: [{ apiKey: [] }],
  request: { query: CompetitorEngagementSweepQuerySchema },
  responses: {
    200: { description: "Sweep result", content: { "application/json": { schema: CompetitorEngagementSweepResponseSchema } } },
    401: { description: "Unauthorized" },
    409: { description: "Already running or migrations not ready", content: { "application/json": { schema: ErrorSchema } } },
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

// --- Internal: one-time suppression BACKFILL (reversible ledger) ---
//
// The inverse repair of the recovery below: per-brand suppression went live on
// 2026-06-15 and was never backfilled, so everyone emailed before that date is
// invisible to the dedup and is re-served — and re-paid for — as if we had never
// seen them. The caller supplies the exact set of people who were ACTUALLY
// EMAILED, each with the real send time, and each is suppressed for the
// REMAINDER of their own three-month window. The window itself is unchanged.

export const BackfillSentSuppressionsQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', report exactly which entries would get a suppression row (with per-brand counts and how many still fall inside the live window) WITHOUT writing. Defaults to false (real run).",
    }),
});

export const BackfillSentSuppressionsRequestSchema = z
  .object({
    reason: z.string().min(1).openapi({
      description:
        "Incident tag written onto every created row's ledger entry — how the repair is later identified and reverted (e.g. 'pre-guard-sends-2026-08').",
    }),
    entries: z
      .array(
        z.object({
          // Lax UUID SHAPE (not strict-v4): org ids can predate the v4
          // convention, same as every other org-id read here.
          orgId: z
            .string()
            .regex(LAX_UUID_REGEX, "orgId must be a valid UUID"),
          brandId: z.string().uuid(),
          email: z.string().min(1),
          sentAt: z.string().datetime({ offset: true }).openapi({
            description:
              "When this person was ACTUALLY emailed for this brand (ISO 8601). It becomes the row's last_served_at, so the person is suppressed for the remainder of THEIR window rather than granted a fresh three months. Never inferred here.",
          }),
        })
      )
      .min(1)
      .openapi({
        description:
          "The exact set of people who were actually EMAILED. The caller supplies it because evidence of what was really sent lives with the service that submitted to the vendor — it is never inferred, and never derived from bare serves (a serve the vendor never contacted is what /internal/recover-suppressions exists to repair).",
      }),
  })
  .openapi("BackfillSentSuppressionsRequest");

export const BackfillSentSuppressionsResponseSchema = z
  .object({
    dryRun: z.boolean(),
    reason: z.string(),
    requested: z.number().int(),
    distinct: z.number().int().openapi({
      description:
        "Distinct (org, brand, normalized email) keys — the grain brand_suppressions is unique on. Duplicates collapse onto their LATEST send.",
    }),
    backfilled: z.number().int().openapi({
      description:
        "Suppression rows created (0 on a dry-run; the would-act count is `wouldBackfill`).",
    }),
    wouldBackfill: z.number().int(),
    wouldSuppressNow: z.number().int().openapi({
      description:
        "Of `wouldBackfill`, those whose send is still inside the live three-month window — the ones that actually stop a re-serve today.",
    }),
    alreadyBackfilled: z.number().int().openapi({
      description:
        "Entries already backfilled under this reason — idempotency: a re-run writes none of them.",
    }),
    alreadySuppressed: z.number().int().openapi({
      description:
        "Entries that already hold a live suppression row: left untouched, never re-dated.",
    }),
    byBrand: z.array(
      z.object({
        brandId: z.string(),
        count: z.number().int(),
        withinWindow: z.number().int(),
      })
    ),
    sample: z.array(
      z.object({
        orgId: z.string(),
        brandId: z.string(),
        emailNorm: z.string(),
        sentAt: z.string(),
      })
    ),
  })
  .openapi("BackfillSentSuppressionsResponse");

registry.registerPath({
  method: "post",
  path: "/internal/backfill-sent-suppressions",
  summary:
    "One-time data repair: suppress a caller-supplied set of people who were actually EMAILED before per-brand suppression existed, each for the remainder of their own three-month window, so the fleet stops re-buying emails it already owns (idempotent, dry-runnable, reversible via /internal/backfill-sent-suppressions/revert)",
  security: [{ apiKey: [] }],
  request: {
    query: BackfillSentSuppressionsQuerySchema,
    body: {
      content: {
        "application/json": { schema: BackfillSentSuppressionsRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Backfill result",
      content: {
        "application/json": { schema: BackfillSentSuppressionsResponseSchema },
      },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

export const RevertSentSuppressionBackfillRequestSchema = z
  .object({
    reason: z.string().min(1).openapi({
      description: "The incident tag whose created suppression rows should be removed.",
    }),
  })
  .openapi("RevertSentSuppressionBackfillRequest");

export const RevertSentSuppressionBackfillResponseSchema = z
  .object({
    dryRun: z.boolean(),
    reason: z.string(),
    ledgerRows: z.number().int(),
    removed: z.number().int(),
    wouldRemove: z.number().int(),
    skippedReserved: z.number().int().openapi({
      description:
        "Backfilled rows re-served since (last_served_at moved past the recorded sent_at) — that row now records a REAL emission, so it is kept.",
    }),
    alreadyRemoved: z.number().int().openapi({
      description:
        "Ledger rows whose suppression row is already gone (e.g. a recovery removed it).",
    }),
  })
  .openapi("RevertSentSuppressionBackfillResponse");

registry.registerPath({
  method: "post",
  path: "/internal/backfill-sent-suppressions/revert",
  summary:
    "Undo a suppression backfill: delete every brand_suppressions row this reason created (keeping any re-served since) and drop the ledger rows",
  security: [{ apiKey: [] }],
  request: {
    query: BackfillSentSuppressionsQuerySchema,
    body: {
      content: {
        "application/json": {
          schema: RevertSentSuppressionBackfillRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Revert result",
      content: {
        "application/json": {
          schema: RevertSentSuppressionBackfillResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

// --- Internal: one-time suppression recovery (reversible ledger) ---

export const RecoverSuppressionsQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "When 'true', report exactly which entries hold a live suppression row (with per-brand counts) WITHOUT writing. Defaults to false (real run).",
    }),
});

export const RecoverSuppressionsRequestSchema = z
  .object({
    reason: z.string().min(1).openapi({
      description:
        "Incident tag written onto every archived row — how the repair is later identified and reverted (e.g. 'instantly-timezone-enum-2026-08').",
    }),
    entries: z
      .array(
        z.object({
          // Lax UUID SHAPE (not strict-v4): org ids can predate the v4
          // convention, same as every other org-id read here.
          orgId: z
            .string()
            .regex(LAX_UUID_REGEX, "orgId must be a valid UUID"),
          brandId: z.string().uuid(),
          email: z.string().min(1),
        })
      )
      .min(1)
      .openapi({
        description:
          "The exact set to recover. The caller supplies it because 'was this person actually handed to the vendor?' is knowable only by the service that submitted to the vendor — it is never inferred here.",
      }),
  })
  .openapi("RecoverSuppressionsRequest");

export const RecoverSuppressionsResponseSchema = z
  .object({
    dryRun: z.boolean(),
    reason: z.string(),
    requested: z.number().int(),
    distinct: z.number().int().openapi({
      description:
        "Distinct (org, brand, normalized email) keys — the grain brand_suppressions is unique on.",
    }),
    recovered: z.number().int().openapi({
      description:
        "Suppression rows archived + deleted (0 on a dry-run; the would-act count is `wouldRecover`).",
    }),
    wouldRecover: z.number().int(),
    alreadyRecovered: z.number().int().openapi({
      description:
        "Entries already archived under this reason — idempotency: a re-run acts on none of them.",
    }),
    notSuppressed: z.number().int().openapi({
      description:
        "Entries holding neither a live suppression row nor a prior archive: nothing to recover.",
    }),
    byBrand: z.array(
      z.object({ brandId: z.string(), count: z.number().int() })
    ),
    sample: z.array(
      z.object({
        orgId: z.string(),
        brandId: z.string(),
        emailNorm: z.string(),
      })
    ),
  })
  .openapi("RecoverSuppressionsResponse");

registry.registerPath({
  method: "post",
  path: "/internal/recover-suppressions",
  summary:
    "One-time data repair: archive + delete the brand_suppressions rows for a caller-supplied set of people who were served but never contacted, so they become emittable again for their brand (idempotent, dry-runnable, reversible via /internal/recover-suppressions/revert)",
  security: [{ apiKey: [] }],
  request: {
    query: RecoverSuppressionsQuerySchema,
    body: {
      content: {
        "application/json": { schema: RecoverSuppressionsRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Recovery result",
      content: {
        "application/json": { schema: RecoverSuppressionsResponseSchema },
      },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

export const RevertSuppressionRecoveryRequestSchema = z
  .object({
    reason: z.string().min(1).openapi({
      description: "The incident tag whose archived rows should be restored.",
    }),
  })
  .openapi("RevertSuppressionRecoveryRequest");

export const RevertSuppressionRecoveryResponseSchema = z
  .object({
    dryRun: z.boolean(),
    reason: z.string(),
    archived: z.number().int(),
    restored: z.number().int(),
    wouldRestore: z.number().int(),
    skippedResuppressed: z.number().int().openapi({
      description:
        "Archived entries suppressed again by a fresh serve since the recovery — the newer row wins and is never clobbered.",
    }),
  })
  .openapi("RevertSuppressionRecoveryResponse");

registry.registerPath({
  method: "post",
  path: "/internal/recover-suppressions/revert",
  summary:
    "Undo a suppression recovery: restore every archived brand_suppressions row carrying this reason (verbatim) and drop the ledger rows",
  security: [{ apiKey: [] }],
  request: {
    query: RecoverSuppressionsQuerySchema,
    body: {
      content: {
        "application/json": {
          schema: RevertSuppressionRecoveryRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Revert result",
      content: {
        "application/json": {
          schema: RevertSuppressionRecoveryResponseSchema,
        },
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

// --- POST /orgs/audiences/split + /orgs/audiences/split/confirm ---
// The light, conceptual split of a confirmed target into at most 6 audiences
// (src/services/audience-split.ts). No Apollo call, no count: one writing call
// splits the text (and guesses each segment's size), one typed judgment picks
// each card's icon.

export const SplitAudiencesRequestSchema = z
  .object({
    brandId: z.string().uuid(),
    targetAudience: z.string().trim().min(1).openapi({
      description:
        "The confirmed free-text answer to 'who do you sell to?' (e.g. 'B2B SaaS founders in the US and Europe').",
    }),
  })
  .openapi("SplitAudiencesRequest");

export const SplitSegmentSchema = z
  .object({
    name: z.string().openapi({ description: "Short label, max 4 words, unique within the proposal." }),
    description: z.string().openapi({
      description:
        "One plain-language sentence that fully specifies the segment on its own (who, where, what kind of company, plus this segment's partition value). Becomes the audience's description on confirm.",
    }),
    icon: z.enum(Object.keys(SPLIT_ICONS) as [string, ...string[]]).openapi({
      description:
        "Phosphor icon name (kebab-case) from a closed vocabulary; `globe-hemisphere-west` renders as <GlobeHemisphereWest /> in @phosphor-icons/react.",
    }),
    iconConfidence: z.number().min(0).max(1).openapi({
      description: "The judge's own certainty about the icon (decorative: the icon is always set).",
    }),
    estimatedLeadCount: z.number().int().positive().nullable().openapi({
      description:
        "Approximate number of people (decision-makers matching the segment) it would reach in a large B2B contact database, estimated by the same generation that writes the segments: no search runs, so it is available instantly with the cards. Right order of magnitude only; the real people-search count is measured after confirm. null when no estimate could be made, never 0.",
    }),
  })
  .openapi("SplitSegment");

export const SplitAudiencesResponseSchema = z
  .object({
    axes: z.array(z.enum(SPLIT_AXES)).openapi({
      description:
        "The axes the segments partition the target along: empty when a single segment is returned, one axis, or two axes crossed. Only axes a people search can filter on.",
    }),
    segments: z.array(SplitSegmentSchema).min(1).max(6).openapi({
      description:
        "1 to 6 mutually exclusive segments that together cover the target. Nothing is persisted.",
    }),
  })
  .openapi("SplitAudiencesResponse");

const ESTIMATE_MEANING =
  "Approximate number of people with a verified email in Apollo who match a quick draft of Apollo People Search filters written from the segment sentence (one cheap LLM call for the whole list, then one free count per segment). Similar-title matching is switched off, so title-based segments are not inflated (~10x) by Apollo's similar titles. Rounded to 2 significant figures. An order of magnitude to show on a card, NOT the audience's final count: the confirmed audience runs its own full build, whose count can differ.";

export const EstimateSplitSegmentsRequestSchema = z
  .object({
    brandId: z.string().uuid(),
    offerId: z.string().uuid().optional().openapi({
      description: "The offer the segments were proposed for. Accepted for attribution in logs; it does not change the estimate.",
    }),
    segments: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            description: z.string().trim().min(1),
          })
          .passthrough()
      )
      .min(1)
      .max(8)
      .openapi({
        description:
          "The proposed segments as returned by /orgs/audiences/split (or /orgs/audiences/suggest): name + description each, 1 to 8. Extra fields (icon, estimatedLeadCount) are accepted and ignored.",
      }),
  })
  .openapi("EstimateSplitSegmentsRequest");

export const SegmentEstimateSchema = z
  .object({
    name: z.string().openapi({ description: "The segment name, as sent." }),
    estimatedPeople: z.number().int().nonnegative().nullable().openapi({ description: ESTIMATE_MEANING + " null only when unavailableReason is set." }),
    unavailableReason: z.enum(["no_filters_drafted", "filters_rejected"]).nullable().openapi({
      description:
        "Why no number could be measured for this segment (null when estimatedPeople is set): no_filters_drafted = the model wrote no filters for it, twice; filters_rejected = the search refused its filters, twice.",
    }),
  })
  .openapi("SegmentEstimate");

export const EstimateSplitSegmentsResponseSchema = z
  .object({
    estimates: z.array(SegmentEstimateSchema).openapi({
      description: "One entry per requested segment, in request order. Nothing is persisted, no audience is created.",
    }),
  })
  .openapi("EstimateSplitSegmentsResponse");

export const ConfirmAudienceSplitRequestSchema = z
  .object({
    brandId: z.string().uuid(),
    offerId: z.string().uuid().openapi({
      description: "The brand-service offer the new audiences belong to. Stored verbatim, like brandId.",
    }),
    targetAudience: z.string().trim().min(1).optional().openapi({
      description:
        "The confirmed target the segments were split from, in the customer's words. Restated as a person-level target (who to write to given what this offer sells, the people around them, and the functions that are out) and stored as each audience's nlPrompt.",
    }),
    segments: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            description: z.string().trim().min(1),
          })
          .strip()
      )
      .min(1)
      .max(6)
      .openapi({
        description:
          "The segments the customer kept (at least one). Pass them back as returned by /orgs/audiences/split; icon fields are accepted and ignored.",
      }),
  })
  .openapi("ConfirmAudienceSplitRequest");

export const ConfirmAudienceSplitResponseSchema = z
  .object({
    audiences: z.array(AudienceSchema).openapi({
      description:
        "One ACTIVE audience per confirmed segment, in request order, scoped to the brand and offer, carrying the segment's description. provider=apollo with no apolloAudienceId/filters yet: the Apollo filters are built later by the existing pointer build.",
    }),
  })
  .openapi("ConfirmAudienceSplitResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/split",
  summary:
    "Propose up to 6 non-overlapping audience segments from a target description (no search, no counts, persists nothing)",
  security: [{ apiKey: [] }],
  request: {
    headers: peopleHeaders,
    body: { content: { "application/json": { schema: SplitAudiencesRequestSchema } } },
  },
  responses: {
    200: { description: "Proposed segments", content: { "application/json": { schema: SplitAudiencesResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "LLM / judgment error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/split/estimate",
  summary: "Approximate people count per proposed segment, without creating any audience",
  description:
    "For proposed segments (the cards a visitor picks from), returns one approximate people count each. " +
    ESTIMATE_MEANING +
    " Cost: one LLM call via chat-service for the whole list (plus one repair call only for segments whose draft was refused or matched nobody), billed to the caller's org; the counts are free. Typical latency under 20s. Persists nothing.",
  security: [{ apiKey: [] }],
  request: {
    headers: peopleHeaders,
    body: { content: { "application/json": { schema: EstimateSplitSegmentsRequestSchema } } },
  },
  responses: {
    200: { description: "One estimate per segment", content: { "application/json": { schema: EstimateSplitSegmentsResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    502: { description: "LLM or people-search provider error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/split/confirm",
  summary: "Create the chosen split segments as active audiences under the brand and offer",
  security: [{ apiKey: [] }],
  request: {
    headers: orgsListsHeaders,
    body: { content: { "application/json": { schema: ConfirmAudienceSplitRequestSchema } } },
  },
  responses: {
    201: { description: "Audiences created", content: { "application/json": { schema: ConfirmAudienceSplitResponseSchema } } },
    400: { description: "Invalid request (incl. duplicate segment names)", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    409: { description: "A segment name is already an audience of this brand + offer; nothing created", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- ICP audience portfolio at launch (POST /orgs/audiences/portfolio) ---

const PORTFOLIO_SIGNAL_TYPES = ["hiring", "job_change", "funding"] as const;

export const LaunchAudiencePortfolioRequestSchema = z
  .object({
    brandId: z.string().uuid(),
    offerId: z.string().uuid().openapi({
      description: "The brand-service offer every portfolio audience belongs to. Stored verbatim, like brandId.",
    }),
    targetAudience: z.string().trim().min(1).openapi({
      description:
        "The ICP text the customer validated (who they sell to), in their words. Every portfolio audience is derived from it, and every one carries the same person-level restatement of it as its nlPrompt (the target the pre-pay screen judges each teaser against).",
    }),
  })
  .strict()
  .openapi("LaunchAudiencePortfolioRequest");

const PortfolioAudienceSchema = AudienceSchema.extend({
  kind: z.enum(["cold", "signal"]).openapi({
    description: "cold = a segment of the ICP split (a client profile); signal = one profile narrowed to one buying signal (its profileAudienceId).",
  }),
  signal: z
    .object({ type: z.enum(PORTFOLIO_SIGNAL_TYPES), windowDays: z.number().int() })
    .nullable()
    .openapi({ description: "The buying signal and its rolling recency window. null on a cold audience." }),
  adopted: z.boolean().openapi({
    description: "True for a cold audience that already existed for this brand + offer (confirmed before payment) and was activated rather than re-created.",
  }),
}).openapi("PortfolioAudience");

const PortfolioSignalOutcomeSchema = z
  .object({
    type: z.enum(PORTFOLIO_SIGNAL_TYPES),
    windowDays: z.number().int(),
    profileAudienceId: z.string().uuid().openapi({ description: "The client profile (a cold audience) this signal was measured for." }),
    profileName: z.string(),
    outcome: z.enum(["created", "exists", "below_threshold", "failed"]).openapi({
      description:
        "created = a signal list was added for this profile; exists = the profile already had one; below_threshold = the signal reaches fewer than 20 distinct companies for this profile; failed = the profile's build, the coverage read or the creation failed (logged; the cold audiences still shipped).",
    }),
    people: z.number().int().nullable().openapi({ description: "Verified-email people the signal reaches for the profile. null when not measured." }),
    companies: z.number().int().nullable().openapi({ description: "Distinct companies of those people. null when not measured." }),
    companiesExact: z.boolean().nullable().openapi({ description: "false = companies counted over the first 500 people (a floor)." }),
    audienceId: z.string().uuid().nullable(),
    reason: z.string().nullable(),
  })
  .openapi("PortfolioSignalOutcome");

export const LaunchAudiencePortfolioResponseSchema = z
  .object({
    portfolioId: z.string().uuid(),
    status: z.enum(["building", "ready"]).openapi({
      description:
        "building = the cold audiences are live and the buying-signal audiences are still being measured in the background (call again to read them; nothing is re-spent); ready = every signal has its outcome.",
    }),
    brandId: z.string().uuid(),
    offerId: z.string().uuid(),
    replayed: z.boolean().openapi({
      description: "true when this (brand, offer) portfolio was already launched (or in flight) and the recorded set is returned; nothing new was created.",
    }),
    target: z.string().nullable().openapi({ description: "The nlPrompt every portfolio audience carries." }),
    audiences: z.array(PortfolioAudienceSchema).openapi({
      description: "Cold audiences first, then signal audiences (signal ones appear once status=ready). All created/activated ACTIVE.",
    }),
    signals: z.array(PortfolioSignalOutcomeSchema).openapi({
      description: "One outcome per (client profile, buying signal). Empty while status=building.",
    }),
  })
  .openapi("LaunchAudiencePortfolioResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/audiences/portfolio",
  summary:
    "Launch the ICP audience portfolio for a brand + offer: the cold split (adopted if already confirmed) plus one buying-signal audience per signal reaching 20+ companies, all active. Idempotent per (brand, offer).",
  description:
    "Answers once the cold audiences exist (seconds; ~15s when the split must be written) with status=building; the buying-signal audiences finish in the background (one Apollo exploration of the whole ICP, minutes). Call again with the same body to read the current state: a replay, or a call while a launch for the same brand + offer is in flight, returns the recorded set and creates nothing. A caller that disconnects does not stop the launch. LLM and Apollo costs are declared by chat-service / apollo-service against the caller's org.",
  security: [{ apiKey: [] }],
  request: {
    headers: peopleHeaders,
    body: { content: { "application/json": { schema: LaunchAudiencePortfolioRequestSchema } } },
  },
  responses: {
    200: { description: "The portfolio (created or replayed)", content: { "application/json": { schema: LaunchAudiencePortfolioResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    409: { description: "A cold segment name collided; nothing created", content: { "application/json": { schema: ErrorSchema } } },
    502: { description: "The cold split failed (LLM, brand-service or runs-service); nothing created", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- Internal (staff): what a brand HOLDS in its audiences ---------------------
//
// The dashboard's staff Audience page, through the api-service gateway (staff
// gated there). Pure DB read: no provider call, no spend. Semantics in
// src/services/audience-snapshot.ts.

export const BrandSnapshotParamsSchema = z.object({
  brandId: z.string().uuid(),
});

export const BrandSnapshotQuerySchema = z.object({
  orgId: z.string().regex(LAX_UUID_REGEX).optional().openapi({
    description: "Only this org's audiences of the brand. Omitted ⟹ every org holding the brand.",
  }),
});

export const BrandSnapshotPageQuerySchema = BrandSnapshotQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(500).optional().openapi({ description: "Page size, default 50, max 500." }),
  offset: z.coerce.number().int().min(0).optional().openapi({ description: "Rows to skip, default 0." }),
  acceptedOnly: z.enum(["true", "false"]).optional().openapi({
    description: "'true' ⟹ only rows at least one target audience accepted.",
  }),
});

const SnapshotAudienceRefSchema = z.object({
  audienceId: z.string().uuid(),
  name: z.string().nullable(),
  status: AudienceStatusSchema.nullable(),
  list: AudienceListKindSchema.nullable().openapi({
    description: "What list this audience holds (same vocabulary as Audience.channels[].list). null ⟹ no committed provider.",
  }),
});

const SnapshotCountsSchema = z.object({
  people: z.object({
    held: z.number().int().openapi({ description: "Distinct people we hold: revealed + screened + waiting in the teaser buffer." }),
    revealed: z.number().int().openapi({ description: "Served: email bought, a member of the audience." }),
    screened: z.number().int().openapi({ description: "Judged by the pre-pay screen (free teaser)." }),
    accepted: z.number().int().openapi({ description: "Latest screen verdict passes today's bar (yes-probability > acceptanceBar; v1 rows: their verdict)." }),
    rejected: z.number().int().openapi({ description: "Screened and not accepted." }),
    waiting: z.number().int().openapi({ description: "In the teaser buffer, not judged nor revealed yet." }),
  }),
  companies: z.object({
    held: z.number().int().openapi({ description: "Distinct companies of the people held." }),
    revealed: z.number().int().openapi({ description: "Distinct companies of the revealed people." }),
    accepted: z.number().int().openapi({ description: "Distinct companies with at least one accepted person." }),
  }),
});

export const BrandAudienceSnapshotResponseSchema = z
  .object({
    brandId: z.string().uuid(),
    acceptanceBar: z.number().openapi({ description: "The screen's current yes-probability bar (strict >)." }),
    totals: SnapshotCountsSchema.openapi({ description: "Brand-wide: a person or company held by several lists counts once." }),
    audiences: z.array(
      SnapshotAudienceRefSchema.extend({
        orgId: z.string(),
        offerId: z.string().uuid().nullable(),
        targetText: z.string().nullable().openapi({ description: "The text the screen judges this audience's leads against." }),
      }).merge(SnapshotCountsSchema)
    ),
  })
  .openapi("BrandAudienceSnapshot");

const SnapshotCompanyRefSchema = z.object({
  companyKey: z.string().openapi({ description: "'domain:<domain>' when the domain is known, else 'name:<lowercased name>'." }),
  name: z.string().nullable(),
  domain: z.string().nullable(),
});

export const BrandHeldPeopleResponseSchema = z
  .object({
    brandId: z.string().uuid(),
    acceptanceBar: z.number(),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    people: z.array(
      z.object({
        personKey: z.string().openapi({ description: "Stable key: the provider person id, or 'person:<personId>' for a revealed person with none." }),
        personId: z.string().uuid().nullable().openapi({ description: "human-service people.id once revealed (same id serve-next returns). null for a teaser only." }),
        providerPersonId: z.string().nullable(),
        name: z.string().nullable(),
        title: z.string().nullable(),
        company: SnapshotCompanyRefSchema.nullable(),
        revealed: z.boolean(),
        sources: z.array(
          SnapshotAudienceRefSchema.extend({
            stage: z.enum(["revealed", "screened", "buffered"]),
            verdict: z.enum(["accepted", "rejected"]).nullable(),
            yesProbability: z.number().nullable(),
          })
        ).openapi({ description: "Every list that brought this person in, with how far they went and that audience's verdict." }),
        acceptedBy: z.array(SnapshotAudienceRefSchema.extend({ yesProbability: z.number().nullable() })).openapi({
          description: "Target audiences whose screen accepts this person (0..n).",
        }),
      })
    ),
  })
  .openapi("BrandHeldPeople");

export const BrandHeldPersonCompaniesResponseSchema = z
  .object({
    brandId: z.string().uuid(),
    total: z.number().int().openapi({ description: "Number of people listed (every held person carrying a provider person id)." }),
    people: z.array(
      z.object({
        providerPersonId: z.string().openapi({ description: "Same value as /people providerPersonId (the person key)." }),
        company: SnapshotCompanyRefSchema.nullable().openapi({ description: "Same company the /people row carries; null when we know none." }),
      })
    ),
  })
  .openapi("BrandHeldPersonCompanies");

export const BrandHeldCompaniesResponseSchema = z
  .object({
    brandId: z.string().uuid(),
    acceptanceBar: z.number(),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    companies: z.array(
      SnapshotCompanyRefSchema.extend({
        people: z.object({ held: z.number().int(), revealed: z.number().int(), accepted: z.number().int() }),
        sources: z.array(SnapshotAudienceRefSchema.extend({ people: z.number().int(), accepted: z.number().int() })),
        acceptedBy: z.array(SnapshotAudienceRefSchema.extend({ acceptedPeople: z.number().int() })).openapi({
          description: "Target audiences that accepted at least one person at this company (0..n).",
        }),
      })
    ),
  })
  .openapi("BrandHeldCompanies");

const snapshotErrors = {
  400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
  401: { description: "Unauthorized" },
};

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/audience-snapshot",
  summary: "Staff: per audience (list) of a brand, the people and companies we hold and how many its target accepted. Pure DB read, no spend.",
  security: [{ apiKey: [] }],
  request: { params: BrandSnapshotParamsSchema, query: BrandSnapshotQuerySchema },
  responses: {
    200: { description: "Snapshot", content: { "application/json": { schema: BrandAudienceSnapshotResponseSchema } } },
    ...snapshotErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/audience-snapshot/people",
  summary: "Staff: the people a brand holds across its audiences, each with its source lists and the target audiences that accepted it. Paginated, no spend.",
  description: "Ordered by number of accepting audiences, then revealed first, then name.",
  security: [{ apiKey: [] }],
  request: { params: BrandSnapshotParamsSchema, query: BrandSnapshotPageQuerySchema },
  responses: {
    200: { description: "A page of people", content: { "application/json": { schema: BrandHeldPeopleResponseSchema } } },
    ...snapshotErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/audience-snapshot/person-companies",
  summary: "Every person a brand's lists hold (provider person id) -> their company, in one read. Same relation and company key as /people, no page, no order. Pure DB read, no spend.",
  description: "People with no provider person id (a revealed person with none) are not listed: nothing can join on them.",
  security: [{ apiKey: [] }],
  request: { params: BrandSnapshotParamsSchema, query: BrandSnapshotQuerySchema },
  responses: {
    200: { description: "Every held person's company", content: { "application/json": { schema: BrandHeldPersonCompaniesResponseSchema } } },
    ...snapshotErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/audience-snapshot/companies",
  summary: "Staff: the companies a brand holds people at, with people counts, source lists and accepting target audiences. Paginated, no spend.",
  description: "Ordered by accepted people, then people held, then name.",
  security: [{ apiKey: [] }],
  request: { params: BrandSnapshotParamsSchema, query: BrandSnapshotPageQuerySchema },
  responses: {
    200: { description: "A page of companies", content: { "application/json": { schema: BrandHeldCompaniesResponseSchema } } },
    ...snapshotErrors,
  },
});

// --- Internal: one person, several email addresses (src/services/person-emails.ts) ---
//
// A person (canonical `people` row, `personId`) holds every address they write
// from. `people.email_norm` stays the primary; any address resolves to the person.

export const PersonWithEmailsSchema = z
  .object({
    personId: z.string().uuid(),
    orgId: z.string(),
    fullName: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    primaryEmail: z.string().nullable(),
    emails: PersonEmailsField,
  })
  .openapi("PersonWithEmails");

export const PersonLookupResponseSchema = z
  .object({ person: PersonWithEmailsSchema.nullable().openapi({ description: "null = the org holds no person for this address." }) })
  .openapi("PersonLookupResponse");

export const PersonOrgQuerySchema = z.object({
  orgId: z.string().regex(LAX_UUID_REGEX, "orgId must be a valid UUID").openapi({ description: "Internal org UUID." }),
});

export const PersonByEmailQuerySchema = PersonOrgQuerySchema.extend({
  email: z.string().min(1).openapi({ description: "Any address of the person." }),
});

export const PersonIdParamsSchema = z.object({ personId: z.string().uuid() });

export const AttachPersonEmailRequestSchema = z
  .object({
    orgId: z.string().regex(LAX_UUID_REGEX, "orgId must be a valid UUID"),
    email: z.string().email().openapi({ description: "The extra address to attach." }),
    companyDomain: z.string().min(1).optional().openapi({ description: "Company the address belongs to (e.g. her own practice)." }),
    companyName: z.string().min(1).optional(),
    evidence: z.string().min(1).openapi({
      description: "Why this address is the same human (e.g. 'replied from it to our email sent to the primary address'). Stored verbatim.",
    }),
    attachedBy: z.string().min(1).openapi({ description: "Who attached it: a service name or a staff user id." }),
  })
  .openapi("AttachPersonEmailRequest");

export const AttachPersonEmailResponseSchema = z
  .object({
    attached: z.boolean().openapi({ description: "false = the person already held this address (idempotent)." }),
    person: PersonWithEmailsSchema,
  })
  .openapi("AttachPersonEmailResponse");

registry.registerPath({
  method: "get",
  path: "/internal/people/by-email",
  summary: "Find a person by ANY of their email addresses; returns the person id and every address they hold.",
  security: [{ apiKey: [] }],
  request: { query: PersonByEmailQuerySchema },
  responses: {
    200: { description: "The person, or null", content: { "application/json": { schema: PersonLookupResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/people/{personId}",
  summary: "One person of the org with every email address they hold.",
  security: [{ apiKey: [] }],
  request: { params: PersonIdParamsSchema, query: PersonOrgQuerySchema },
  responses: {
    200: { description: "The person", content: { "application/json": { schema: PersonWithEmailsSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    404: { description: "No such person in this org", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/people/{personId}/emails",
  summary: "Attach an extra email address to an existing person (explicit act, never a guess). Idempotent.",
  description:
    "Facts on any address then hold for the person: per-brand suppression, opt-outs and won leads. An address another person of the org already holds is a 409: merging two people is not done by attaching an address.",
  security: [{ apiKey: [] }],
  request: {
    params: PersonIdParamsSchema,
    body: { content: { "application/json": { schema: AttachPersonEmailRequestSchema } } },
  },
  responses: {
    200: { description: "The person with every address", content: { "application/json": { schema: AttachPersonEmailResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
    404: { description: "No such person in this org", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "The address belongs to another person of the org", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// --- Internal: multi-source provenance (src/services/audience-memberships.ts) ---
//
// Which audiences (hence which lists / sourcing origins) FOUND each person of a
// brand, and per audience how many of its people another audience found too.
// RAW membership (no deprecated -> canonical collapse). Pure DB read, no spend.


export const BrandMembershipsQuerySchema = BrandSnapshotQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(5000).optional().openapi({ description: "People per page, default 1000, max 5000." }),
  offset: z.coerce.number().int().min(0).optional().openapi({ description: "People to skip, default 0." }),
});

const BrandMembershipSchema = z.object({
  audienceId: z.string().uuid(),
  offerId: z.string().uuid().nullable(),
  list: AudienceListKindSchema.nullable(),
  status: AudienceStatusSchema,
  provenance: MembershipProvenanceSchema,
  joinedAt: z.string(),
});

export const BrandMembershipsResponseSchema = z
  .object({
    brandId: z.string().uuid(),
    total: z.number().int().openapi({ description: "Distinct people the brand's audiences found (all pages)." }),
    limit: z.number().int(),
    offset: z.number().int(),
    people: z.array(
      z.object({
        personId: z.string().uuid().openapi({ description: "Canonical human-service person id (= serve-next's personId)." }),
        orgId: z.string(),
        emailNorm: z.string().nullable(),
        emails: PersonEmailsField,
        memberships: z.array(BrandMembershipSchema).openapi({
          description: "Every audience of the brand that found this person, raw (a deprecated audience stays itself), oldest first. Several lists = a multi-source person.",
        }),
      })
    ),
  })
  .openapi("BrandMembershipsResponse");

export const BrandMembershipsByEmailRequestSchema = z
  .object({
    orgId: z.string().regex(LAX_UUID_REGEX).openapi({ description: "Internal org UUID that holds the people." }),
    emails: z.array(z.string().min(1)).min(1).openapi({
      description: "Lead emails, as many as a whole brand holds (25 MB body cap). Each comes back as a key, raw as sent; ANY address of a person resolves to that person.",
    }),
  })
  .openapi("BrandMembershipsByEmailRequest");

export const BrandMembershipsByEmailResponseSchema = z
  .object({
    brandId: z.string().uuid(),
    byEmail: z.record(
      z.string(),
      z
        .object({
          personId: z.string().uuid(),
          emails: PersonEmailsField,
          memberships: z.array(BrandMembershipSchema).openapi({
            description: "Every audience of the brand that found this person, raw, oldest first. [] = a person of the org no audience of this brand found.",
          }),
        })
        .nullable()
        .openapi({ description: "null = the org holds no person for this email." })
    ),
  })
  .openapi("BrandMembershipsByEmailResponse");

registry.registerPath({
  method: "post",
  path: "/internal/brands/{brandId}/memberships/by-email",
  summary: "Per EMAIL: every audience of the brand (list, offer, provenance served|found_taken) that found the person. Raw membership, thousands of emails per call, no spend.",
  description: "Service auth, 25 MB body. Unlike /internal/audiences/resolve (one served-only card per email, unchanged), this answers every membership, found-while-taken included.",
  security: [{ apiKey: [] }],
  request: {
    params: BrandSnapshotParamsSchema,
    body: { content: { "application/json": { schema: BrandMembershipsByEmailRequestSchema } } },
  },
  responses: {
    200: { description: "Memberships per email", content: { "application/json": { schema: BrandMembershipsByEmailResponseSchema } } },
    ...snapshotErrors,
  },
});

export const BrandAudienceOverlapResponseSchema = z
  .object({
    brandId: z.string().uuid(),
    people: z.number().int().openapi({ description: "Distinct people the brand's audiences found." }),
    peopleInSeveralAudiences: z.number().int(),
    peopleInSeveralLists: z.number().int().openapi({ description: "People found by audiences of 2+ list kinds (multi-source)." }),
    audiences: z.array(
      z.object({
        audienceId: z.string().uuid(),
        name: z.string(),
        orgId: z.string(),
        offerId: z.string().uuid().nullable(),
        list: AudienceListKindSchema.nullable(),
        status: AudienceStatusSchema,
        memberCount: z.number().int(),
        servedCount: z.number().int(),
        foundTakenCount: z.number().int(),
        alsoInOtherAudienceCount: z.number().int().openapi({ description: "Members another audience of the brand found too." }),
        alsoInOtherListCount: z.number().int().openapi({ description: "Members an audience of ANOTHER list kind found too." }),
      })
    ),
  })
  .openapi("BrandAudienceOverlapResponse");

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/memberships",
  summary: "Per person of a brand: every audience (list, offer, provenance) that found them. Raw membership, paged by person, no spend.",
  description: "Ordered by personId. Service auth. A person found by several lists is a multi-source (higher-intent) lead.",
  security: [{ apiKey: [] }],
  request: { params: BrandSnapshotParamsSchema, query: BrandMembershipsQuerySchema },
  responses: {
    200: { description: "A page of people with their memberships", content: { "application/json": { schema: BrandMembershipsResponseSchema } } },
    ...snapshotErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/audience-overlap",
  summary: "Per audience of a brand: members, served vs found-while-taken, and how many another audience / list found too. Raw membership, no spend.",
  security: [{ apiKey: [] }],
  request: { params: BrandSnapshotParamsSchema, query: BrandSnapshotQuerySchema },
  responses: {
    200: { description: "Overlap", content: { "application/json": { schema: BrandAudienceOverlapResponseSchema } } },
    ...snapshotErrors,
  },
});

// --- SOURCE CAMPAIGNS (owner 2026-10-07; src/services/source-campaigns.ts) ---
//
// A lead SOURCE of an offer is a campaign-service campaign keyed (offer, featureSlug =
// <origin slug>, legKey = "start_to_lead_found"). ON = its origin's audience exists for
// the offer and is active; OFF = paused, history kept.

const SOURCE_OUTCOMES = [
  "paused",
  "none_active",
  "active",
  "resumed",
  "created",
  "no_target",
  "not_computed",
  "exists_inactive",
  "recorded",
  "unchanged",
  "retired_origin",
  "failed",
] as const;

export const SourceCampaignStateRequestSchema = z
  .object({
    brandId: z.string().regex(LAX_UUID_REGEX, "brandId must be a valid UUID"),
    offerId: z.string().regex(LAX_UUID_REGEX, "offerId must be a valid UUID"),
    originSlug: z.string().min(1).openapi({
      description: "The sourcing origin slug (features-service catalogue), e.g. sourcing-linkedin-engagement-signals.",
    }),
    campaignId: z.string().min(1).nullable().openapi({
      description: "campaign-service's id of the source campaign (null when none exists yet).",
    }),
    status: z.enum(["on", "off"]),
  })
  .openapi("SourceCampaignStateRequest");

export const SourceCampaignStateResponseSchema = z
  .object({
    orgId: z.string(),
    brandId: z.string(),
    offerId: z.string(),
    originSlug: z.string(),
    listKind: z.enum(AUDIENCE_LIST_KINDS).nullable(),
    campaignId: z.string().nullable(),
    status: z.enum(["on", "off"]),
    previousStatus: z.enum(["on", "off"]).nullable(),
    outcome: z.enum(SOURCE_OUTCOMES),
    reason: z.string().nullable(),
    audiences: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
  })
  .openapi("SourceCampaignStateResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/source-campaigns/state",
  summary:
    "A source campaign of an offer was turned ON or OFF (campaign-service owns the switch). ON: the origin's audience exists for the offer and is active (an audience an earlier OFF paused is resumed, else one is created from what the platform knows: the offer's target, its buying signals, competitors' LinkedIn pages, the brand's uploaded contacts). OFF: every active audience of that list under the offer is paused, history kept, and resumed by the next ON. Idempotent. The same state is also reconciled from campaign-service every 2 minutes.",
  security: [{ apiKey: [] }],
  request: { body: { content: { "application/json": { schema: SourceCampaignStateRequestSchema } } } },
  responses: {
    200: { description: "Applied", content: { "application/json": { schema: SourceCampaignStateResponseSchema } } },
    400: { description: "Invalid body or unknown origin", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized" },
  },
});

export const SourceCampaignReconcileQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .openapi({ description: "When 'true', read campaign-service and report what WOULD be applied, writing nothing." }),
  orgId: z.string().regex(LAX_UUID_REGEX, "orgId must be a valid UUID").optional(),
  offerId: z.string().regex(LAX_UUID_REGEX, "offerId must be a valid UUID").optional(),
});

export const SourceCampaignReconcileResponseSchema = z
  .object({
    dryRun: z.boolean(),
    offers: z.number().int(),
    applied: z.number().int(),
    entries: z.array(
      z.object({
        orgId: z.string(),
        brandId: z.string(),
        offerId: z.string(),
        originSlug: z.string().nullable(),
        action: z.enum([...SOURCE_OUTCOMES, "would_apply", "read_failed"]),
        status: z.enum(["on", "off"]).nullable(),
        reason: z.string().nullable(),
      })
    ),
  })
  .openapi("SourceCampaignReconcileResponse");

registry.registerPath({
  method: "post",
  path: "/internal/source-campaigns/reconcile",
  summary:
    "Reconcile now (also runs every 2 minutes): read every offer's source campaigns from campaign-service and apply each on/off that changed since the last one applied. A source campaign seen for the first time is recorded, never treated as a change (an ON one only gets an audience when the offer holds none of its list).",
  security: [{ apiKey: [] }],
  request: { query: SourceCampaignReconcileQuerySchema },
  responses: {
    200: { description: "Reconcile result", content: { "application/json": { schema: SourceCampaignReconcileResponseSchema } } },
    401: { description: "Unauthorized" },
    409: { description: "Already running or migrations not ready", content: { "application/json": { schema: ErrorSchema } } },
  },
});
