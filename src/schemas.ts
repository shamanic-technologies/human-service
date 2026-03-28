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
  "x-brand-id": z.string().optional().openapi({ description: "Brand ID — injected by workflow-service on DAG calls" }),
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
