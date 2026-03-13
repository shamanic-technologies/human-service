import type { WorkflowTrackingHeaders } from "../middleware/auth.js";
import { workflowTrackingToHeaders } from "../middleware/auth.js";

const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL;
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;

interface CallerContext {
  method: string;
  path: string;
}

export interface ResolvedKey {
  key: string;
  keySource: "platform" | "org";
}

export async function resolveApiKey(
  provider: string,
  params: { orgId: string; userId: string; runId: string; workflowTracking?: WorkflowTrackingHeaders },
  callerContext: CallerContext
): Promise<ResolvedKey | null> {
  if (!KEY_SERVICE_URL || !KEY_SERVICE_API_KEY) return null;

  try {
    const endpoint = `${KEY_SERVICE_URL}/keys/${provider}/decrypt`;

    const res = await fetch(endpoint, {
      headers: {
        "x-api-key": KEY_SERVICE_API_KEY,
        "x-org-id": params.orgId,
        "x-user-id": params.userId,
        "x-run-id": params.runId,
        "x-caller-service": "human",
        "x-caller-method": callerContext.method,
        "x-caller-path": callerContext.path,
        ...workflowTrackingToHeaders(params.workflowTracking ?? {}),
      },
    });

    if (!res.ok) return null;
    const data = (await res.json()) as {
      key: string;
      keySource: "platform" | "org";
    };
    return { key: data.key, keySource: data.keySource };
  } catch {
    return null;
  }
}
