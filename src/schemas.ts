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

// --- Shared schemas ---

export const ErrorSchema = z
  .object({
    error: z.string(),
  })
  .openapi("Error");

export const ScrapedPageSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    content: z.string(),
    scrapedAt: z.string(),
  })
  .openapi("ScrapedPage");

export const HumanProfileSchema = z
  .object({
    id: z.string().uuid(),
    appId: z.string(),
    orgId: z.string().nullable(),
    userId: z.string().nullable(),
    name: z.string(),
    urls: z.array(z.string()),
    scrapedPages: z.array(ScrapedPageSchema).nullable(),
    maxPages: z.number().int(),
    writingStyle: z.string().nullable(),
    bio: z.string().nullable(),
    topics: z.array(z.string()).nullable(),
    tone: z.string().nullable(),
    vocabulary: z.string().nullable(),
    lastScrapedAt: z.string().nullable(),
    cacheTtlHours: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("HumanProfile");

// --- POST /profiles ---

export const CreateProfileRequestSchema = z
  .object({
    appId: z.string().min(1),
    orgId: z.string().min(1),
    userId: z.string().min(1),
    keySource: z.enum(["app", "byok"]),
    runId: z.string().min(1),
    name: z.string().min(1),
    urls: z.array(z.string().url()).min(1),
    maxPages: z.number().int().min(1).max(10).optional(),
    cacheTtlHours: z.number().int().min(1).optional(),
  })
  .openapi("CreateProfileRequest");

export const CreateProfileResponseSchema = z
  .object({
    profile: HumanProfileSchema,
  })
  .openapi("CreateProfileResponse");

registry.registerPath({
  method: "post",
  path: "/profiles",
  summary: "Create or update a profile",
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: CreateProfileRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Profile created or updated",
      content: {
        "application/json": { schema: CreateProfileResponseSchema },
      },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

// --- GET /profiles/:orgId ---

export const GetProfileResponseSchema = z
  .object({
    profile: HumanProfileSchema,
    isStale: z.boolean().optional(),
  })
  .openapi("GetProfileResponse");

registry.registerPath({
  method: "get",
  path: "/profiles/{orgId}",
  summary: "Get cached profile",
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ orgId: z.string() }),
    query: z.object({
      appId: z.string().min(1),
      userId: z.string().min(1),
    }),
  },
  responses: {
    200: {
      description: "Profile found",
      content: {
        "application/json": { schema: GetProfileResponseSchema },
      },
    },
    404: {
      description: "Profile not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

// --- POST /profiles/:orgId/scrape ---

export const ScrapeRequestSchema = z
  .object({
    appId: z.string().min(1),
    orgId: z.string().min(1),
    userId: z.string().min(1),
    keySource: z.enum(["app", "byok"]),
    runId: z.string().min(1),
    maxPages: z.number().int().min(1).max(10).optional(),
    forceRefresh: z.boolean().optional(),
  })
  .openapi("ScrapeRequest");

export const ScrapeResponseSchema = z
  .object({
    profile: HumanProfileSchema,
    pagesScraped: z.number().int(),
  })
  .openapi("ScrapeResponse");

registry.registerPath({
  method: "post",
  path: "/profiles/{orgId}/scrape",
  summary: "Trigger scrape and AI extraction",
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ orgId: z.string() }),
    body: {
      content: {
        "application/json": { schema: ScrapeRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Scrape completed",
      content: {
        "application/json": { schema: ScrapeResponseSchema },
      },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Profile not found",
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
