/**
 * Postgres SQLSTATE of a failed query, wherever it sits in the error chain.
 *
 * drizzle-orm >= 0.44 wraps every driver error in a `DrizzleQueryError` whose
 * `.cause` is the original postgres.js error (the one carrying `.code`, e.g.
 * "23505" for unique_violation). Reading `err.code` on the wrapper alone
 * returns undefined, so walk the `.cause` chain.
 */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
