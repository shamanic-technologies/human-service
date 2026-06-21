// Thin client for chat-service POST /complete — the org-scoped, billed +
// run-tracked one-shot LLM endpoint. chat-service OWNS the LLM cost
// (provision→authorize→execute→actualize against the org balance), so
// human-service declares no cost of its own for the suggest flow — it forwards
// the identity headers and lets chat-service meter the spend.
//
// Fail loud: a non-2xx (incl. a 402 when the org can't afford the call) throws
// ChatServiceError → surfaced as 502 by the route. Connect-phase retry only
// (thrown rejection, never a completed HTTP response) for the Neon cold-start
// edge — same pattern as people-providers' fetchWithConnectRetry.

export class ChatServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ChatServiceError";
  }
}

export class ChatConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatConfigError";
  }
}

import type { WorkflowTrackingHeaders } from "../middleware/auth.js";
import { workflowTrackingToHeaders } from "../middleware/auth.js";

export interface ChatIdentity {
  orgId: string;
  userId?: string;
  runId?: string;
  // Workflow tracking block (incl. x-audience-id) — forwarded verbatim to
  // chat-service so it can attribute its LLM/image cost to the campaign's
  // priority audience. chat-service is an internal sibling; the block carries
  // no vendor-bound secrets. Absent outside the campaign flow → omitted.
  workflowTracking?: WorkflowTrackingHeaders;
}

const TRANSIENT_CODES = ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN"];
const RETRY_BACKOFF_MS = [250, 500, 1000];

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

function requireChat(): { url: string; key: string } {
  const url = process.env.CHAT_SERVICE_URL;
  const key = process.env.CHAT_SERVICE_API_KEY;
  if (!url || !key) {
    throw new ChatConfigError(
      "CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY not configured"
    );
  }
  return { url, key };
}

// One-shot JSON LLM completion via chat-service. Returns the parsed `json`
// object. JSON-mode contract differs by provider:
//   - `anthropic`: chat-service rejects `responseFormat:"json"` with 400 unless
//     a `responseSchema` is supplied, and Anthropic enforces it STRICTLY —
//     `additionalProperties:false` + an explicit `properties` map on EVERY
//     object (open/permissive objects are rejected). So an anthropic JSON caller
//     MUST pass a fully-enumerated strict `responseSchema`.
//   - `google`: native JSON mode (`responseMimeType:"application/json"`) needs
//     NO schema — `responseFormat:"json"` alone suffices, and the shape is
//     prompt-described + validated caller-side. This is what the suggest flow
//     uses, since its open `filters` blob can't be expressed as an Anthropic
//     strict schema without over-constraining it.
// `responseSchema` is added to the body only when present (omit ⇒ unchanged).
export async function completeJson(args: {
  message: string;
  systemPrompt: string;
  identity: ChatIdentity;
  responseSchema?: Record<string, unknown>;
  provider?: "anthropic" | "google";
  model?: string;
  temperature?: number;
}): Promise<Record<string, unknown>> {
  const { url, key } = requireChat();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": key,
    "x-org-id": args.identity.orgId,
    ...(args.identity.userId ? { "x-user-id": args.identity.userId } : {}),
    ...(args.identity.runId ? { "x-run-id": args.identity.runId } : {}),
    ...workflowTrackingToHeaders(args.identity.workflowTracking ?? {}),
  };
  const body = {
    message: args.message,
    systemPrompt: args.systemPrompt,
    responseFormat: "json",
    ...(args.responseSchema ? { responseSchema: args.responseSchema } : {}),
    provider: args.provider ?? "anthropic",
    model: args.model ?? "sonnet",
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
  };

  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/complete`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ChatServiceError(0, `chat-service unreachable: ${String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ChatServiceError(res.status, text);
  }
  const data = (await res.json()) as { json?: Record<string, unknown> };
  if (!data.json || typeof data.json !== "object") {
    throw new ChatServiceError(
      502,
      "chat-service returned no parsed json field"
    );
  }
  return data.json;
}

// One-shot JSON LLM completion via chat-service POST /internal/platform-complete
// — the ORG-LESS, service-auth platform path (auth = x-api-key only, no
// x-org-id/x-user-id/x-run-id). chat-service resolves the PLATFORM provider key
// and OWNS whatever cost the call incurs (platform-run declaration lives there),
// so human-service declares none. Use this for internal service-to-service LLM
// work that does NOT belong to a specific org/user (e.g. a one-time historical
// backfill we owe users — billing their orgs retroactively would be wrong, and a
// sweep-all-orgs job has no x-user-id anyway). Same JSON-mode contract as
// /complete: with `google` (used here) native JSON mode needs NO responseSchema.
// Fail loud: a non-2xx throws ChatServiceError; an unreachable host throws
// ChatServiceError(0). Returns the parsed `json` object.
export async function platformCompleteJson(args: {
  message: string;
  systemPrompt: string;
  provider?: "anthropic" | "google";
  model?: string;
  temperature?: number;
}): Promise<Record<string, unknown>> {
  const { url, key } = requireChat();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": key,
  };
  const body = {
    message: args.message,
    systemPrompt: args.systemPrompt,
    responseFormat: "json",
    provider: args.provider ?? "anthropic",
    model: args.model ?? "sonnet",
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
  };

  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/internal/platform-complete`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ChatServiceError(0, `chat-service unreachable: ${String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ChatServiceError(res.status, text);
  }
  const data = (await res.json()) as { json?: Record<string, unknown> };
  if (!data.json || typeof data.json !== "object") {
    throw new ChatServiceError(
      502,
      "chat-service returned no parsed json field"
    );
  }
  return data.json;
}

export interface GeneratedImage {
  imageBase64: string;
  mimeType: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  text?: string;
}

// One-shot image generation via chat-service POST /orgs/images/generate. As with
// /complete, chat-service OWNS the cost (provision→authorize→execute→actualize
// against the org balance) — human-service declares none, it only forwards the
// prompt + identity headers and stores the returned bytes. Fail loud: a non-2xx
// (incl. a 402 when the org can't afford the call) throws ChatServiceError → 502.
export async function generateImage(args: {
  prompt: string;
  identity: ChatIdentity;
}): Promise<GeneratedImage> {
  const { url, key } = requireChat();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": key,
    "x-org-id": args.identity.orgId,
    ...(args.identity.userId ? { "x-user-id": args.identity.userId } : {}),
    ...(args.identity.runId ? { "x-run-id": args.identity.runId } : {}),
    ...workflowTrackingToHeaders(args.identity.workflowTracking ?? {}),
  };

  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/orgs/images/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: args.prompt }),
    });
  } catch (err) {
    throw new ChatServiceError(0, `chat-service unreachable: ${String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ChatServiceError(res.status, text);
  }
  const data = (await res.json()) as Partial<GeneratedImage>;
  if (!data.imageBase64 || !data.mimeType) {
    throw new ChatServiceError(
      502,
      "chat-service returned no image bytes / mime type"
    );
  }
  return data as GeneratedImage;
}
