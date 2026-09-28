import type { WorkflowTrackingHeaders } from "../middleware/auth.js";
import { workflowTrackingToHeaders } from "../middleware/auth.js";

// Read at call time (not import time), like every other sibling client here.
function runsEnv(): { url: string | undefined; key: string | undefined } {
  return {
    url: process.env.RUNS_SERVICE_URL,
    key: process.env.RUNS_SERVICE_API_KEY,
  };
}

interface IdentityContext {
  orgId: string;
  userId: string;
  workflowTracking?: WorkflowTrackingHeaders;
}

interface CreateRunParams extends IdentityContext {
  parentRunId?: string;
  taskName: string;
}

interface CostItem {
  costName: string;
  costSource: "platform" | "org";
  quantity: number;
}

export async function createRun(
  params: CreateRunParams
): Promise<string | null> {
  const { url: RUNS_SERVICE_URL, key: RUNS_SERVICE_API_KEY } = runsEnv();
  if (!RUNS_SERVICE_URL || !RUNS_SERVICE_API_KEY) return null;

  try {
    const res = await fetch(`${RUNS_SERVICE_URL}/v1/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": RUNS_SERVICE_API_KEY,
        "x-org-id": params.orgId,
        "x-user-id": params.userId,
        ...(params.parentRunId ? { "x-run-id": params.parentRunId } : {}),
        ...workflowTrackingToHeaders(params.workflowTracking ?? {}),
      },
      body: JSON.stringify({
        serviceName: "human-service",
        taskName: params.taskName,
      }),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { id: string };
    return data.id;
  } catch {
    return null;
  }
}

export async function addCosts(
  runId: string,
  items: CostItem[],
  identity: IdentityContext
): Promise<void> {
  const { url: RUNS_SERVICE_URL, key: RUNS_SERVICE_API_KEY } = runsEnv();
  if (!RUNS_SERVICE_URL || !RUNS_SERVICE_API_KEY) return;

  try {
    await fetch(`${RUNS_SERVICE_URL}/v1/runs/${runId}/costs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": RUNS_SERVICE_API_KEY,
        "x-org-id": identity.orgId,
        "x-user-id": identity.userId,
        "x-run-id": runId,
        ...workflowTrackingToHeaders(identity.workflowTracking ?? {}),
      },
      body: JSON.stringify({ items }),
    });
  } catch {
    // Best-effort cost tracking
  }
}

export async function completeRun(
  runId: string,
  status: "completed" | "failed",
  identity: IdentityContext
): Promise<void> {
  const { url: RUNS_SERVICE_URL, key: RUNS_SERVICE_API_KEY } = runsEnv();
  if (!RUNS_SERVICE_URL || !RUNS_SERVICE_API_KEY) return;

  try {
    await fetch(`${RUNS_SERVICE_URL}/v1/runs/${runId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": RUNS_SERVICE_API_KEY,
        "x-org-id": identity.orgId,
        "x-user-id": identity.userId,
        "x-run-id": runId,
        ...workflowTrackingToHeaders(identity.workflowTracking ?? {}),
      },
      body: JSON.stringify({ status }),
    });
  } catch {
    // Best-effort
  }
}
