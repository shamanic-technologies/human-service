// The serve answers' email-verdict contract (CATCHALL-SERVE-OPTION-1013).
//
// A caller that states `acceptedEmails` on serve-next / candidates reveal reads
// `emailVerdict` on every `served` answer: the verification verdict of the
// address handed (`valid`, `catch_all`), null when the serve ran no
// verification (crm, apify). A caller that states nothing reads the body it
// always read, byte for byte: the field is never on the wire for it.

import type { AcceptedEmails, EmailVerdict } from "./email-verification.js";

export function shapeEmailVerdict<T extends { status: string; emailVerdict?: EmailVerdict | null }>(
  result: T,
  accepted: AcceptedEmails | undefined
): T {
  const { emailVerdict, ...rest } = result;
  if (accepted === undefined || result.status !== "served") return rest as T;
  return { ...rest, emailVerdict: emailVerdict ?? null } as T;
}
