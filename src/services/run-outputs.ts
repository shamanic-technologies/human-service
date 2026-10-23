// What a run human-service OPENED produced (COST-ACCOUNTING-1023, owner 2026-10-23).
//
// runs-service is the general ledger of what each outcome costs to produce: a
// run is a production order, and its whole cost (own rows + descendants that
// declare nothing: chat-service LLM calls, apollo-service builds) is split over
// the outcome occurrences it DECLARES. A run that declares nothing reads
// "produced none". human-service's one duty: every run it opens names what it
// built.
//
// What human-service builds is a LIST of people to reach: an audience row, or a
// source added to one (`audience_sources`: a buying signal, competitor-post
// engagement). Catalogue step `audience_built` (subjectKind object, declared in
// features-service 2026-10-23), subject = `human-service` + the audience id or
// the audience_sources id (both uuids, never colliding).
//
// Mechanism: a call site runs the work of its own run inside
// `withRunOutputs(runId, fn)`; every writer that creates a list calls
// `noteListBuilt(id)`, which records it on the run whose context it runs in
// (AsyncLocalStorage: concurrent runs never mix, a nested own run, e.g. a
// pointer build opened inside a portfolio launch, gets its own set);
// `completeRun` takes the set and declares it. A writer running under a
// CALLER's run (an inbound x-run-id) is in no tracked context: nothing is
// recorded here, the caller's service declares its own run.
import { AsyncLocalStorage } from "node:async_hooks";

interface RunOutputs {
  runId: string;
  built: Set<string>;
  closed: boolean;
}

const context = new AsyncLocalStorage<RunOutputs>();
const open = new Map<string, RunOutputs>();

function outputsOf(runId: string): RunOutputs {
  let outputs = open.get(runId);
  if (!outputs) {
    outputs = { runId, built: new Set(), closed: false };
    open.set(runId, outputs);
  }
  return outputs;
}

/**
 * Run `fn` in the output context of a run we opened: every list it (or anything
 * it awaits or starts) creates is recorded on that run. Several calls for one
 * run share one set (a portfolio launch wraps its cold part and its background
 * signal part). Scoped `run()`, never `enterWith`: enterWith re-labels the
 * CALLER's context too once it awaits (measured on Node 20, pinned by
 * tests/unit/run-outcomes.test.ts).
 */
export function withRunOutputs<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return context.run(outputsOf(runId), fn);
}

/** Record lists a run built when the call site holds their ids itself. */
export function addRunOutputs(runId: string, listIds: string[]): void {
  const outputs = outputsOf(runId);
  if (outputs.closed) {
    console.error(`[human-service] run_outputs.after_close run=${runId} lists=${listIds.join(",")}`);
    return;
  }
  for (const id of listIds) outputs.built.add(id);
}

/** A list (audience or audience source) was just CREATED: record it on the current own run, if any. */
export function noteListBuilt(listId: string): void {
  const outputs = context.getStore();
  if (!outputs) return;
  if (outputs.closed) {
    // Already declared (e.g. the background pointer build of an audience the
    // run created and declared): nothing missing.
    if (outputs.built.has(listId)) return;
    // Background work that outlived its run: loud, so a missing declaration is visible.
    console.error(
      `[human-service] run_outputs.after_close run=${outputs.runId} list=${listId}: the run already declared its outputs, this list is not declared on it`
    );
    return;
  }
  outputs.built.add(listId);
}

/** The lists the run built, once: closes the run's set (later notes are logged, never declared). */
export function takeRunOutputs(runId: string): string[] {
  const outputs = open.get(runId);
  if (!outputs) return [];
  open.delete(runId);
  outputs.closed = true;
  return [...outputs.built];
}
