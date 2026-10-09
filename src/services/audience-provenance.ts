// Audience provenance: who FOUND a person.
//
// A person is a member of every audience whose search found them (owner
// 2026-10-08: "It must be tagged both ... So we know a human belongs to several
// signals, which is a higher interest"). Two ways to become one:
//
//   served       — a serve made under the audience handed the person out
//                  (tagAudienceServe in audiences.ts).
//   found_taken  — the audience's FREE search found the person while they were
//                  already taken (served) for the brand (tagFoundAlreadyTaken
//                  below). The person is NOT served again: suppression is
//                  unchanged, this only records the fact the free match observed.
//                  Nothing is paid for it: the identity comes from the teaser's
//                  own keys plus the suppression row it matched.
//
// Lives apart from audiences.ts so the people gateway (people-providers.ts, which
// audiences.ts imports) can tag without an import cycle.

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audienceMembers, people, personEmails } from "../db/schema.js";
import { recordServedEmail } from "./person-emails.js";
import {
  normalizeEmail,
  normalizeLinkedinUrl,
  type ServedContact,
  type SuppressionMatch,
} from "./suppression.js";

export type MembershipProvenance = "served" | "found_taken";

// The transaction handle drizzle passes to the `db.transaction` callback.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Resolve (dedup) a served contact into the canonical `people` dimension,
// returning its person id. Match order: email_norm (canonical, ANY address of the
// person: person-emails.ts) -> linkedin -> provider person id. Merges
// newly-learned identity fields onto the existing row (coalesce: prefer the new
// value, keep the old when the new is null), and records the address on the
// person, so an address a person used before stays theirs when the primary moves.
export async function resolvePersonId(
  tx: Tx,
  orgId: string,
  c: ServedContact
): Promise<string> {
  const personId = await resolvePersonRow(tx, orgId, c);
  const emailNorm = normalizeEmail(c.email);
  if (emailNorm) {
    await recordServedEmail(tx, orgId, personId, emailNorm, c.companyDomain);
  }
  return personId;
}

async function resolvePersonRow(
  tx: Tx,
  orgId: string,
  c: ServedContact
): Promise<string> {
  const emailNorm = normalizeEmail(c.email);
  const linkedinNorm = normalizeLinkedinUrl(c.linkedinUrl);
  const apolloId =
    c.provider === "apollo" && c.providerPersonId ? c.providerPersonId : null;
  const apifyId =
    c.provider === "apify" && c.providerPersonId ? c.providerPersonId : null;

  const keyConds = [];
  if (emailNorm) {
    keyConds.push(eq(people.emailNorm, emailNorm));
    keyConds.push(
      inArray(
        people.id,
        tx
          .select({ id: personEmails.personId })
          .from(personEmails)
          .where(and(eq(personEmails.orgId, orgId), eq(personEmails.emailNorm, emailNorm)))
      )
    );
  }
  if (linkedinNorm) keyConds.push(eq(people.linkedinUrlNorm, linkedinNorm));
  if (apolloId) keyConds.push(eq(people.apolloPersonId, apolloId));
  if (apifyId) keyConds.push(eq(people.apifyPersonId, apifyId));

  const fullName =
    c.firstName || c.lastName
      ? [c.firstName, c.lastName].filter(Boolean).join(" ")
      : null;

  if (keyConds.length > 0) {
    const [existing] = await tx
      .select()
      .from(people)
      .where(and(eq(people.orgId, orgId), or(...keyConds)))
      .limit(1);
    if (existing) {
      // Revealed at one of the person's OTHER addresses: the primary stays.
      const keepPrimary =
        emailNorm !== null &&
        existing.emailNorm !== null &&
        existing.emailNorm !== emailNorm &&
        (
          await tx
            .select({ id: personEmails.id })
            .from(personEmails)
            .where(
              and(
                eq(personEmails.orgId, orgId),
                eq(personEmails.emailNorm, emailNorm),
                eq(personEmails.personId, existing.id)
              )
            )
            .limit(1)
        ).length > 0;
      await tx
        .update(people)
        .set({
          emailNorm: keepPrimary ? existing.emailNorm : emailNorm ?? existing.emailNorm,
          linkedinUrlNorm: linkedinNorm ?? existing.linkedinUrlNorm,
          apolloPersonId: apolloId ?? existing.apolloPersonId,
          apifyPersonId: apifyId ?? existing.apifyPersonId,
          firstName: c.firstName ?? existing.firstName,
          lastName: c.lastName ?? existing.lastName,
          fullName: fullName ?? existing.fullName,
          companyDomain: c.companyDomain ?? existing.companyDomain,
          lastSeenAt: new Date(),
        })
        .where(eq(people.id, existing.id));
      return existing.id;
    }
  }

  // No match — insert. ON CONFLICT (org_id, email_norm) covers the race where a
  // concurrent serve created the same email between the select and the insert.
  if (emailNorm) {
    const [row] = await tx
      .insert(people)
      .values({
        orgId,
        emailNorm,
        linkedinUrlNorm: linkedinNorm,
        apolloPersonId: apolloId,
        apifyPersonId: apifyId,
        firstName: c.firstName,
        lastName: c.lastName,
        fullName,
        companyDomain: c.companyDomain,
      })
      .onConflictDoUpdate({
        target: [people.orgId, people.emailNorm],
        set: {
          linkedinUrlNorm: sql`coalesce(excluded.linkedin_url_norm, ${people.linkedinUrlNorm})`,
          apolloPersonId: sql`coalesce(excluded.apollo_person_id, ${people.apolloPersonId})`,
          apifyPersonId: sql`coalesce(excluded.apify_person_id, ${people.apifyPersonId})`,
          lastSeenAt: sql`now()`,
        },
      })
      .returning({ id: people.id });
    return row.id;
  }

  const [row] = await tx
    .insert(people)
    .values({
      orgId,
      emailNorm: null,
      linkedinUrlNorm: linkedinNorm,
      apolloPersonId: apolloId,
      apifyPersonId: apifyId,
      firstName: c.firstName,
      lastName: c.lastName,
      fullName,
      companyDomain: c.companyDomain,
    })
    .returning({ id: people.id });
  return row.id;
}

// Record that `audienceId`'s free search found people already taken for the
// brand. Idempotent: an existing membership of that person in that audience is
// left exactly as it is (a 'served' row stays 'served'). The canonical person is
// resolved from the suppression row's address (the key the serve recorded) and
// the teaser's own pre-pay keys; the teaser's names are NOT written (apollo's free
// teaser masks the last name, so it must never overwrite the revealed one).
//
// The caller MUST have validated that `audienceId` belongs to `orgId`.
export async function tagFoundAlreadyTaken(
  orgId: string,
  audienceId: string,
  provider: "apollo" | "apify",
  taken: Array<{
    item: { linkedinUrl: string | null; providerPersonId: string | null };
    match: SuppressionMatch;
  }>
): Promise<string[]> {
  const personIds: string[] = [];
  for (const { item, match } of taken) {
    const contact: ServedContact = {
      email: match.emailNorm,
      linkedinUrl: item.linkedinUrl ?? match.linkedinUrlNorm,
      firstName: null,
      lastName: null,
      companyDomain: null,
      provider,
      providerPersonId: item.providerPersonId,
    };
    await db.transaction(async (tx) => {
      const personId = await resolvePersonId(tx, orgId, contact);
      personIds.push(personId);
      await tx
        .insert(audienceMembers)
        .values({
          orgId,
          audienceId,
          personId,
          source: provider,
          confidence: "provider_confirmed",
          provenance: "found_taken",
        })
        .onConflictDoNothing({
          target: [audienceMembers.audienceId, audienceMembers.personId],
        });
    });
  }
  if (taken.length > 0) {
    console.log(
      `[human-service] audience.found_taken org=${orgId} audience=${audienceId} count=${taken.length}`
    );
  }
  return personIds;
}
