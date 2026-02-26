const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL;
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY;

interface CreateRunParams {
  appId: string;
  orgId: string;
  parentRunId: string;
  taskName: string;
}

interface CostItem {
  costName: string;
  quantity: number;
}

export async function createChildRun(
  params: CreateRunParams
): Promise<string | null> {
  if (!RUNS_SERVICE_URL || !RUNS_SERVICE_API_KEY) return null;

  try {
    const res = await fetch(`${RUNS_SERVICE_URL}/v1/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": RUNS_SERVICE_API_KEY,
      },
      body: JSON.stringify({
        orgId: params.orgId,
        appId: params.appId,
        serviceName: "human",
        taskName: params.taskName,
        parentRunId: params.parentRunId,
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
  items: CostItem[]
): Promise<void> {
  if (!RUNS_SERVICE_URL || !RUNS_SERVICE_API_KEY) return;

  try {
    await fetch(`${RUNS_SERVICE_URL}/v1/runs/${runId}/costs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": RUNS_SERVICE_API_KEY,
      },
      body: JSON.stringify({ items }),
    });
  } catch {
    // Best-effort cost tracking
  }
}

export async function completeRun(
  runId: string,
  status: "completed" | "failed"
): Promise<void> {
  if (!RUNS_SERVICE_URL || !RUNS_SERVICE_API_KEY) return;

  try {
    await fetch(`${RUNS_SERVICE_URL}/v1/runs/${runId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": RUNS_SERVICE_API_KEY,
      },
      body: JSON.stringify({ status }),
    });
  } catch {
    // Best-effort
  }
}
