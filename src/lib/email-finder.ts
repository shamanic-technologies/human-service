// Client for apollo-service's email finder (`POST /email-finder/find`, vendor
// treg): a person's work email from name + company domain, or a LinkedIn URL.
// Used when the CRM pipe serves a contact the client added without an email
// (CRM-ADD-ONE-CONTACT-1021), at REVEAL time only, so the lookup runs inside the
// campaign's caps.
//
// apollo-service OWNS the spend: it provisions / authorizes / actualizes or
// cancels the cost on the caller's run (`x-run-id` = the campaign's serve run,
// forwarded by downstreamHeaders) and never pays twice for one person (its
// silver `email_findings` row answers a repeat with `reused: true`). So
// human-service declares no cost, exactly as for every other apollo-service call.
// A found address comes back with its verifier verdict, like every reveal.
//
// Fail loud: a non-2xx (402 credit refusal, 503 key missing, ...) or a `failed`
// finding throws ProviderError("apollo"). `pending` (treg still running, apollo
// keeps the hold) is returned as such: the caller asks again later, for free.

import { apolloPost, ProviderError, type Identity } from "../services/people-providers.js";

export const EMAIL_FINDER_VENDOR = "treg" as const;

export interface FindEmailPerson {
  firstName?: string;
  lastName?: string;
  domain?: string;
  linkedinUrl?: string;
}

export type FindEmailResult =
  | { status: "found"; email: string; emailVerification: unknown; reused: boolean }
  | { status: "not_found"; reused: boolean }
  | { status: "pending" };

// What treg accepts: a LinkedIn URL, or first + last name + domain. null = this
// contact cannot be looked up at all (nothing is asked, nothing is spent).
export function findablePerson(c: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  companyDomain?: string | null;
  linkedinUrl?: string | null;
}): FindEmailPerson | null {
  let first = c.firstName?.trim() || null;
  let last = c.lastName?.trim() || null;
  if ((!first || !last) && c.fullName?.trim()) {
    const parts = c.fullName.trim().split(/\s+/);
    if (parts.length >= 2) {
      first = first ?? parts[0];
      last = last ?? parts.slice(1).join(" ");
    }
  }
  const domain = normalizeDomain(c.companyDomain);
  const linkedinUrl = c.linkedinUrl?.trim() || null;
  const byName = first && last && domain ? { firstName: first, lastName: last, domain } : null;
  if (!byName && !linkedinUrl) return null;
  return { ...(byName ?? {}), ...(linkedinUrl ? { linkedinUrl } : {}) };
}

// "https://www.ntt.com/en/" → "ntt.com". crm-service already normalizes, this
// only guards an older row.
export function normalizeDomain(raw: string | null | undefined): string | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  const host = v.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
  return host.includes(".") ? host : null;
}

export async function findEmail(person: FindEmailPerson, identity: Identity): Promise<FindEmailResult> {
  const body = (await apolloPost(
    "/email-finder/find",
    { vendor: EMAIL_FINDER_VENDOR, person },
    identity
  )) as { status?: unknown; email?: unknown; emailVerification?: unknown; reused?: unknown };
  const reused = body.reused === true;
  if (body.status === "found" && typeof body.email === "string" && body.email.trim()) {
    return { status: "found", email: body.email.trim(), emailVerification: body.emailVerification ?? null, reused };
  }
  if (body.status === "not_found") return { status: "not_found", reused };
  if (body.status === "pending") return { status: "pending" };
  throw new ProviderError("apollo", 502, `email-finder answered ${JSON.stringify(body).slice(0, 300)}`);
}
