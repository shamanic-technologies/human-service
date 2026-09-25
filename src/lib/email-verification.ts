// Pre-serve email verification — READ, not performed, here.
//
// Getting a correct, deliverable address is the provider's responsibility, so
// apollo-service verifies every email it reveals (BounceVerify actor: real SMTP
// + catch-all detection) and returns the verdict beside the person, on /enrich
// and /match:
//
//   emailVerification: { email, verdict, deliverable, verifier, ... } | null
//
// `deliverable` is true only for verdict `valid` (catch_all, invalid, unknown and
// risky are not deliverable) — apollo-service owns that policy and its cost
// (`apify-bounceverify-email`). human-service only acts on the answer: a
// non-deliverable person is recorded as served (never re-bought) and dropped.
//
// Measured on 100 bounced + 100 delivered production addresses before the gate
// shipped: invalid 24/3, unknown 32/15, catch_all 41/46, valid 3/36 — i.e.
// ~40%, ~15%, ~7% and <1% bounce inside each verdict.
//
// human-service verified emails itself in v0.46.3/v0.46.4; that moved to
// apollo-service (#267) on the owner's call: human-service manages humans.

export type EmailVerdict = "valid" | "invalid" | "catch_all" | "risky" | "unknown";

export interface EmailVerification {
  verdict: EmailVerdict;
  deliverable: boolean;
}

export class EmailVerificationError extends Error {
  constructor(message: string) {
    super(`[human-service] email verification: ${message}`);
    this.name = "EmailVerificationError";
  }
}

const VERDICTS: ReadonlySet<string> = new Set(["valid", "invalid", "catch_all", "risky", "unknown"]);

// Read the provider's verdict for a revealed email. No email ⟹ nothing to
// verify (null). An email WITHOUT a well-formed verdict is a contract violation
// and fails loud: serving an unverified address is exactly what the gate exists
// to prevent, so there is no "assume deliverable" fallback.
export function readEmailVerification(
  provider: string,
  raw: unknown,
  email: string | null | undefined
): EmailVerification | null {
  if (!email || !email.trim()) return null;
  const v = raw as { verdict?: unknown; deliverable?: unknown } | null | undefined;
  if (!v || typeof v.deliverable !== "boolean" || typeof v.verdict !== "string" || !VERDICTS.has(v.verdict)) {
    throw new EmailVerificationError(
      `${provider} returned an email without a usable emailVerification (got ${JSON.stringify(raw ?? null).slice(0, 200)})`
    );
  }
  return { verdict: v.verdict as EmailVerdict, deliverable: v.deliverable };
}
