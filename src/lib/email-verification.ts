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

// Which verdicts a serve may hand out, as the caller's workflow states it
// (CATCHALL-SERVE-OPTION-1013). `valid_only` is the default and what every
// caller that states nothing gets. `valid_and_catch_all` also hands out a
// catch_all address (~7% bounce measured, vs ~15% unknown, ~40% invalid), so a
// market that ran out of confirmed mailboxes keeps reaching people.
// `valid_catch_all_and_unknown` (UNKNOWN-EMAILS-OPTION-1014, owner 2026-10-14)
// used to also hand out an address the verifier could not judge (verdict
// unknown). SUPERSEDED on 2026-10-16 (CATCHALL-BOUNCE-1016): an `unknown` address
// is never emailed, fleet-wide. Measured: unknown bounced 36.8% over 30 days
// (vs catch_all 10.7%, valid 2.2%), and 4 of 5 on "Cold Follow-up Replies"; the
// cold-email deliverability consensus agrees (LeadMagic: unknown is not
// sequencer-ready for cold outbound; ZeroBounce: an unknown is retried after
// 24-48 h, never sent as is). instantly-service refuses an unknown at send, so
// serving one only made the brand pay a reveal nobody can email. The value is
// DEPRECATED and still accepted (a caller sending it must not start failing):
// it behaves exactly as `valid_and_catch_all`. invalid, risky and unknown are
// never handed out, whatever the caller asks.
export const ACCEPTED_EMAILS = ["valid_only", "valid_and_catch_all", "valid_catch_all_and_unknown"] as const;
export type AcceptedEmails = (typeof ACCEPTED_EMAILS)[number];

// The verdicts beyond `valid` each option also hands out: what a fresh reveal
// may serve, and what the re-reach of people already paid for looks for.
// `unknown` is in NO entry (CATCHALL-BOUNCE-1016): the deprecated value maps to
// catch_all only, so no serve path (fresh reveal, re-reach, candidate reveal)
// can hand out an unknown-verdict person.
const WIDENED_VERDICTS: Record<AcceptedEmails, readonly EmailVerdict[]> = {
  valid_only: [],
  valid_and_catch_all: ["catch_all"],
  valid_catch_all_and_unknown: ["catch_all"],
};

export function widenedVerdicts(accepted: AcceptedEmails | undefined): readonly EmailVerdict[] {
  return WIDENED_VERDICTS[accepted ?? "valid_only"];
}

// Apply the caller's policy to the provider's verdict. The provider's own
// `deliverable` (valid only) stays the default; the caller can only widen it to
// catch_all (never unknown, CATCHALL-BOUNCE-1016).
export function isVerdictAccepted(
  verification: EmailVerification,
  accepted: AcceptedEmails | undefined
): boolean {
  if (verification.deliverable) return true;
  return widenedVerdicts(accepted).includes(verification.verdict);
}
