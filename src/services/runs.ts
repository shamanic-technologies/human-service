import type { WorkflowTrackingHeaders } from "../middleware/auth.js";
import { workflowTrackingToHeaders } from "../middleware/auth.js";
import { takeRunOutputs } from "./run-outputs.js";
import type { PlatformSupportKind } from "../lib/chat-client.js";

/** Catalogue step of every list human-service builds (see run-outputs.ts). */
export const AUDIENCE_BUILT = "audience_built";
export const SUBJECT_SERVICE = "human-service";
/** runs-service caps one declaration at 1000 occurrences. */
const DECLARE_CHUNK = 1000;

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

/**
 * Support functions (runs-service, cost-accounting doctrine): spend that produces
 * no outcome BY DESIGN, named and reported apart. A run marked support at
 * creation never declares an outcome.
 */
export type SupportFunction = PlatformSupportKind;

export interface RunSupport {
  kind: SupportFunction;
  reason: string;
}

/**
 * The runs human-service opens whose spend produces no outcome by design
 * (LEDGER-HISTORY-1024). Marked at creation; the same table marks the past ones
 * (run-outcomes-backfill.ts), so a run made today and one made last month read
 * the same in the ledger.
 */
export const TASK_SUPPORT: Record<string, RunSupport> = {
  // Writes the person-level target text of audiences a split confirm / suggestion
  // creates after it: an onboarding step, never a list of its own.
  "audience-target-draft": {
    kind: "product_feature",
    reason: "audience target draft: the target text of audiences an onboarding step creates, no list of its own",
  },
  // Sizes the proposed segments for the signed-out onboarding cards: creates nothing.
  "audience-split-estimate": {
    kind: "product_feature",
    reason: "audience split estimate: sizes onboarding segment cards, creates no list",
  },
  // The signed-out companies preview (apollo-service declares what it researched).
  "audience-preview-companies": {
    kind: "product_feature",
    reason: "audience companies preview: signed-out onboarding sample, no list built",
  },
};

interface CreateRunParams extends IdentityContext {
  parentRunId?: string;
  taskName: string;
  /** Mark the run SUPPORT at creation (its spend produces no outcome by design). */
  support?: RunSupport;
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
        ...(params.support ? { support: params.support } : {}),
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

/**
 * Declare the lists a run of ours built (`audience_built`, produced) on that
 * run. Idempotent on runs-service's side (same occurrence = already_recorded).
 * A failure is logged loud with the ids, never thrown: the lists exist and the
 * run's lifecycle must still close.
 */
export async function declareListsBuilt(
  runId: string,
  listIds: string[],
  identity: IdentityContext
): Promise<void> {
  if (listIds.length === 0) return;
  const { url: RUNS_SERVICE_URL, key: RUNS_SERVICE_API_KEY } = runsEnv();
  if (!RUNS_SERVICE_URL || !RUNS_SERVICE_API_KEY) {
    console.error(`[human-service] run_outcomes.unconfigured run=${runId} lists=${listIds.join(",")}`);
    return;
  }
  for (let i = 0; i < listIds.length; i += DECLARE_CHUNK) {
    const chunk = listIds.slice(i, i + DECLARE_CHUNK);
    try {
      const res = await fetch(`${RUNS_SERVICE_URL}/v1/runs/${runId}/outcomes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": RUNS_SERVICE_API_KEY,
          "x-org-id": identity.orgId,
          "x-user-id": identity.userId,
          "x-service-name": SUBJECT_SERVICE,
          ...workflowTrackingToHeaders(identity.workflowTracking ?? {}),
        },
        body: JSON.stringify({
          produced: chunk.map((subjectId) => ({ outcomeKey: AUDIENCE_BUILT, subjectService: SUBJECT_SERVICE, subjectId })),
        }),
      });
      if (!res.ok) {
        console.error(
          `[human-service] run_outcomes.declare_failed run=${runId} status=${res.status} lists=${chunk.join(",")}: ${(await res.text()).slice(0, 300)}`
        );
      }
    } catch (err) {
      console.error(`[human-service] run_outcomes.declare_failed run=${runId} lists=${chunk.join(",")}`, err);
    }
  }
}

export async function completeRun(
  runId: string,
  status: "completed" | "failed",
  identity: IdentityContext
): Promise<void> {
  // What the run built is declared whatever its status: a failed run that still
  // created some lists made them (a failure itself is never an outcome).
  await declareListsBuilt(runId, takeRunOutputs(runId), identity);
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
