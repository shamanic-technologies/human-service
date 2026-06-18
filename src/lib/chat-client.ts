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

export interface ChatIdentity {
  orgId: string;
  userId?: string;
  runId?: string;
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

// One-shot JSON LLM completion via chat-service. We rely on `responseFormat:
// "json"` + an explicit shape described in the prompt (and Zod-validate the
// result caller-side) rather than a provider-enforced `responseSchema` — the
// neutral filter shape has many optional fields and anthropic strict-mode
// rejects permissive schemas, so prompt-described + caller-validated is the
// robust, provider-agnostic path. Returns the parsed `json` object.
export async function completeJson(args: {
  message: string;
  systemPrompt: string;
  identity: ChatIdentity;
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
