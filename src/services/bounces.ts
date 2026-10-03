// Hard bounces on the serve path — "our own send to this address bounced".
//
// FLEET-WIDE, unlike the two exclusions beside it:
//   • per-brand suppression (suppression.ts) is a timing rule for one brand;
//   • a standing opt-out (opt-outs.ts) is consent given to one org.
// A bounce is neither: it is a fact about the ADDRESS. A mailbox that rejected
// our mail for org A rejects it for org B, so a recorded bounce excludes the
// person for every org and every brand, with or without a brand on the request,
// and it never lapses. Measured before this shipped (human-service#73): 275
// addresses re-served after a recorded bounce, 106 emailed again.
//
// instantly-service OWNS the record (see lib/instantly-bounces). This module
// owns only the RESOLUTION, the same way opt-outs.ts does: the free apollo
// teaser masks the email and carries a linkedin url + an apollo person id, so to
// exclude BEFORE the paid reveal we look those keys up in what this gateway has
// already revealed — our `people` rows and the `lead_serves` bronze — to find the
// address they belong to, then ask the owner whether it bounced. That lookup is
// deliberately NOT org-scoped: an apollo person id / a linkedin url names the
// same human in every org, and the fact we test is fleet-wide. Measured on prod
// the day this shipped: 272 of the 276 served-after-bounce addresses resolved
// through a `people` row's apollo person id, so the free gate is the one that
// fires; the rest are caught post-reveal (finalizeResolved), whose recorded
// serve then ties the key to the address for every later request.
//
// Absent is absent: a candidate with no key we have ever revealed cannot be
// matched pre-pay, and is never rejected for it.
//
// Fail loud: the owner unreachable ⟹ BounceSourceError ⟹ 502. Never serve
// through an unreadable record.

import { and, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { leadServes, people } from "../db/schema.js";
import { findBouncedEmails } from "../lib/instantly-bounces.js";
import { normalizeEmail, normalizeLinkedinUrl } from "./suppression.js";
import type { Identity } from "./people-providers.js";

export interface BounceCandidate {
  email?: string | null;
  linkedinUrl?: string | null;
  providerPersonId?: string | null;
}

// Every address our own records tie to these pre-pay keys, per key.
async function resolveKnownEmails(
  personIds: string[],
  linkedinUrls: string[]
): Promise<{ byPersonId: Map<string, Set<string>>; byLinkedin: Map<string, Set<string>> }> {
  const byPersonId = new Map<string, Set<string>>();
  const byLinkedin = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string | null, e: string | null) => {
    if (!k || !e) return;
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set()));
    s.add(e);
  };
  if (personIds.length === 0 && linkedinUrls.length === 0) {
    return { byPersonId, byLinkedin };
  }

  const keyConds = [
    ...(personIds.length > 0
      ? [
          inArray(people.apolloPersonId, personIds),
          inArray(people.apifyPersonId, personIds),
        ]
      : []),
    ...(linkedinUrls.length > 0
      ? [inArray(people.linkedinUrlNorm, linkedinUrls)]
      : []),
  ];
  const [peopleRows, serveRows] = await Promise.all([
    db
      .select({
        emailNorm: people.emailNorm,
        apolloPersonId: people.apolloPersonId,
        apifyPersonId: people.apifyPersonId,
        linkedinUrlNorm: people.linkedinUrlNorm,
      })
      .from(people)
      .where(and(isNotNull(people.emailNorm), or(...keyConds))),
    personIds.length > 0
      ? db
          .select({
            email: sql<string>`lower(trim(${leadServes.email}))`,
            providerPersonId: leadServes.providerPersonId,
          })
          .from(leadServes)
          .where(
            and(
              isNotNull(leadServes.email),
              inArray(leadServes.providerPersonId, personIds)
            )
          )
      : Promise.resolve([] as { email: string; providerPersonId: string | null }[]),
  ]);

  for (const r of peopleRows) {
    add(byPersonId, r.apolloPersonId, r.emailNorm);
    add(byPersonId, r.apifyPersonId, r.emailNorm);
    add(byLinkedin, r.linkedinUrlNorm, r.emailNorm);
  }
  for (const r of serveRows) {
    add(byPersonId, r.providerPersonId, normalizeEmail(r.email));
  }
  return { byPersonId, byLinkedin };
}

// Drop every candidate whose address bounced on one of our sends — matched on
// the candidate's own email when it carries one, and otherwise on every address
// our records tie to its linkedin url / provider person id. One local query and
// at most one call to the owner per batch; no call at all when nothing resolves.
export async function filterBounced<T extends BounceCandidate>(
  identity: Identity,
  items: T[]
): Promise<T[]> {
  if (items.length === 0) return items;

  const personIds = [
    ...new Set(
      items.map((i) => i.providerPersonId).filter((x): x is string => !!x)
    ),
  ];
  const linkedinUrls = [
    ...new Set(
      items
        .map((i) => normalizeLinkedinUrl(i.linkedinUrl))
        .filter((x): x is string => x !== null)
    ),
  ];
  const known = await resolveKnownEmails(personIds, linkedinUrls);

  const emailsOf = (i: T): Set<string> => {
    const out = new Set<string>();
    const own = normalizeEmail(i.email);
    if (own) out.add(own);
    if (i.providerPersonId) {
      for (const e of known.byPersonId.get(i.providerPersonId) ?? []) out.add(e);
    }
    const li = normalizeLinkedinUrl(i.linkedinUrl);
    if (li) for (const e of known.byLinkedin.get(li) ?? []) out.add(e);
    return out;
  };

  const perItem = items.map(emailsOf);
  const all = [...new Set(perItem.flatMap((s) => [...s]))];
  if (all.length === 0) return items;

  const bounced = await findBouncedEmails(identity, all);
  if (bounced.size === 0) return items;

  return items.filter((_, idx) => {
    const hit = [...perItem[idx]].some((e) => bounced.has(e));
    if (hit) {
      console.log(
        `[human-service] bounce.blocked org=${identity.orgId} person=${items[idx].providerPersonId ?? "-"}`
      );
    }
    return !hit;
  });
}

// Post-reveal / crm: did this exact address bounce on one of our sends?
export async function isEmailBounced(
  identity: Identity,
  email: string | null | undefined
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (normalized === null) return false;
  const bounced = await findBouncedEmails(identity, [normalized]);
  return bounced.has(normalized);
}
