import type { WorkflowTrackingHeaders } from "../middleware/auth.js";
import { workflowTrackingToHeaders } from "../middleware/auth.js";

const SERVICE_NAME = "human-service";
const TRANSIENT_CODES = ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN"];
const RETRY_BACKOFF_MS = [250, 500, 1000];

export class CloudflareServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "CloudflareServiceError";
  }
}

export class CloudflareConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareConfigError";
  }
}

export interface CloudflareUploadResult {
  id: string;
  url: string;
  size: number;
  contentType: string;
}

export interface CloudflareOrgIdentity {
  orgId: string;
  userId: string;
  runId: string;
  workflowTracking?: WorkflowTrackingHeaders;
}

function requireCloudflare(): { url: string; key: string } {
  const url = process.env.CLOUDFLARE_SERVICE_URL;
  const key = process.env.CLOUDFLARE_SERVICE_API_KEY;
  if (!url || !key) {
    throw new CloudflareConfigError(
      "CLOUDFLARE_SERVICE_URL and CLOUDFLARE_SERVICE_API_KEY are required"
    );
  }
  return { url: url.replace(/\/+$/, ""), key };
}

function isTransientConnectError(err: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (e: unknown): boolean => {
    if (!e || typeof e !== "object" || seen.has(e)) return false;
    seen.add(e);
    const anyE = e as {
      code?: string;
      cause?: unknown;
      errors?: unknown[];
      message?: string;
    };
    if (anyE.code && TRANSIENT_CODES.includes(anyE.code)) return true;
    if (
      typeof anyE.message === "string" &&
      /fetch failed|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(anyE.message)
    )
      return true;
    if (Array.isArray(anyE.errors) && anyE.errors.some(visit)) return true;
    return visit(anyE.cause);
  };
  return visit(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithConnectRetry(
  url: string,
  init: RequestInit
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_BACKOFF_MS.length && isTransientConnectError(err)) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/svg+xml") return "svg";
  return "png";
}

function assertUploadResult(value: unknown): CloudflareUploadResult {
  if (!value || typeof value !== "object") {
    throw new CloudflareServiceError(
      502,
      "cloudflare-service returned an invalid upload body"
    );
  }
  const body = value as Partial<CloudflareUploadResult>;
  if (
    typeof body.id !== "string" ||
    typeof body.url !== "string" ||
    typeof body.size !== "number" ||
    typeof body.contentType !== "string"
  ) {
    throw new CloudflareServiceError(
      502,
      "cloudflare-service upload response is missing id, url, size, or contentType"
    );
  }
  return {
    id: body.id,
    url: body.url,
    size: body.size,
    contentType: body.contentType,
  };
}

async function postBase64Upload(
  path: "/upload/base64" | "/internal/upload/base64",
  headers: Record<string, string>,
  body: {
    contentBase64: string;
    contentType: string;
    folder: string;
    filename: string;
  }
): Promise<CloudflareUploadResult> {
  const { url, key } = requireCloudflare();
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new CloudflareServiceError(
      0,
      `cloudflare-service unreachable: ${String(err)}`
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CloudflareServiceError(res.status, text);
  }
  return assertUploadResult(await res.json());
}

export function avatarFilename(
  audienceId: string,
  mimeType: string,
  suffix = "avatar"
): string {
  return `${audienceId}-${suffix}.${extensionForMimeType(mimeType)}`;
}

export async function uploadAudienceAvatarBase64(args: {
  contentBase64: string;
  contentType: string;
  orgId: string;
  brandId: string;
  audienceId: string;
  identity: CloudflareOrgIdentity;
}): Promise<CloudflareUploadResult> {
  return postBase64Upload(
    "/upload/base64",
    {
      "x-org-id": args.identity.orgId,
      "x-user-id": args.identity.userId,
      "x-run-id": args.identity.runId,
      ...workflowTrackingToHeaders(args.identity.workflowTracking ?? {}),
    },
    {
      contentBase64: args.contentBase64,
      contentType: args.contentType,
      folder: `human-service/audience-avatars/${args.orgId}/${args.brandId}`,
      filename: avatarFilename(args.audienceId, args.contentType),
    }
  );
}

export async function uploadAudienceAvatarBase64Platform(args: {
  contentBase64: string;
  contentType: string;
  orgId: string;
  brandId: string;
  audienceId: string;
  suffix?: string;
}): Promise<CloudflareUploadResult> {
  return postBase64Upload(
    "/internal/upload/base64",
    { "x-service-name": SERVICE_NAME },
    {
      contentBase64: args.contentBase64,
      contentType: args.contentType,
      folder: `human-service/audience-avatars/${args.orgId}/${args.brandId}`,
      filename: avatarFilename(args.audienceId, args.contentType, args.suffix),
    }
  );
}

export function parseDataUriAvatar(dataUri: string): {
  contentType: string;
  contentBase64: string;
} | null {
  const match = dataUri.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return null;
  return {
    contentType: match[1],
    contentBase64: match[2].replace(/\s/g, ""),
  };
}
