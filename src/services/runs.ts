const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL;
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY;

interface IdentityContext {
  orgId: string;
  userId: string;
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
      },
      body: JSON.stringify({ status }),
    });
  } catch {
    // Best-effort
  }
}
