import type { ZodError } from "zod";

// A 400 an outside caller (often an AI agent) can act on from its FIRST line:
// `error` names every offending field and what was expected
// ("brandId: Invalid UUID; segments.0.name: Too small: expected string to have >=1 characters"),
// never Zod's JSON dump of the issues array. `issues` carries the same facts
// structured (additive; `error` stays the field every caller already reads).
// AGENT-SIGNUP-UX-1125.

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

function pathOf(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0 ? "body" : path.map((p) => String(p)).join(".");
}

export function zodIssues(err: ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({ path: pathOf(i.path), message: i.message, code: i.code }));
}

export function zodErrorMessage(err: ZodError): string {
  return zodIssues(err)
    .map((i) => `${i.path}: ${i.message}`)
    .join("; ");
}

export function zodErrorBody(err: ZodError): { error: string; issues: ValidationIssue[] } {
  return { error: zodErrorMessage(err), issues: zodIssues(err) };
}
