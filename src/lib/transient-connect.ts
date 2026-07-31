/**
 * Connect-phase failure detection, shared by the boot migration retry and the
 * platform-key registration retry.
 *
 * "Transient" here means strictly one thing: the request never reached the far
 * side. A Neon compute suspended by scale-to-zero (and a Railway sibling that is
 * asleep) rejects or stalls the first attempts while it wakes, which is expected
 * on a deploy that lands cold — retrying is the whole point. Anything NOT in
 * this set is a real failure: loud, terminal, never retried.
 */

const TRANSIENT_CONNECT_CODES = new Set([
  // Node socket / DNS layer
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  // postgres.js client-side connection errors
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECTION_REFUSED",
  // Postgres SQLSTATE class 08 (connection exception) + a resuming/saturated compute
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P03", // cannot_connect_now — the server is starting up
  "53300", // too_many_connections
]);

/**
 * Message fragments postgres.js / pg surface without a machine-readable code.
 * Kept narrow on purpose: a wide regex here would swallow a real schema error.
 */
const TRANSIENT_MESSAGE_RE =
  /connect\s+(?:etimedout|econnrefused|econnreset)|timeout expired|timeout exceeded when trying to connect|connection terminated|write connection_closed|the database system is starting up|could not connect/i;

/**
 * True when `err` (or anything in its `cause` chain / `AggregateError.errors`)
 * is a connect-phase failure. Node's happy-eyeballs wraps per-address failures
 * in an `AggregateError`, and `fetch`/postgres.js nest the real cause, so a flat
 * `err.code` check misses the common shapes.
 */
export function isTransientConnectError(err: unknown, seen = new Set<unknown>()): boolean {
  if (err === null || typeof err !== "object" || seen.has(err)) return false;
  seen.add(err);

  const candidate = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };

  if (typeof candidate.code === "string" && TRANSIENT_CONNECT_CODES.has(candidate.code)) {
    return true;
  }
  if (typeof candidate.message === "string" && TRANSIENT_MESSAGE_RE.test(candidate.message)) {
    return true;
  }
  if (Array.isArray(candidate.errors) && candidate.errors.some((e) => isTransientConnectError(e, seen))) {
    return true;
  }
  return isTransientConnectError(candidate.cause, seen);
}

/** Human-readable one-liner for a log or a 503 body. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
