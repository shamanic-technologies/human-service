// One person, several email addresses (owner 2026-10-09: "one HUMAN in Human
// Service (human id), with several email addresses").
//
// A real person often writes from more than one mailbox: a work address and a
// personal or second-company one. `people.email_norm` stays the person's PRIMARY
// address (every existing read keeps it, unchanged); `person_emails` holds EVERY
// address the person has, the primary included, each with the company it belongs
// to when known. An address belongs to at most one person per org, so asking
// about ANY of them resolves to the same person id.
//
// How an address joins a person, and only these two ways:
//   served   — the gateway saw it on a serve / reveal of that person
//              (resolvePersonId records it).
//   attached — an explicit act by a service or staff (`attachPersonEmail`), with
//              the evidence that says it is the same human. Never inferred here:
//              no name matching, no domain guess, no automatic merge of two
//              existing people (an address already held by ANOTHER person is a
//              409, never a silent move).
//
// Facts keyed on an address hold for the PERSON: per-brand suppression and the
// opt-out / won gates expand an address to every address of its person
// (`personAddressSet`). A hard bounce does NOT: it is a fact about the mailbox,
// not about the human (bounces.ts stays per address).
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { people, personEmails } from "../db/schema.js";
import { normalizeEmail } from "./suppression.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

export type PersonEmailSource = "served" | "attached";

export interface PersonEmailView {
  email: string;
  primary: boolean;
  companyDomain: string | null;
  companyName: string | null;
  source: PersonEmailSource;
  addedAt: string;
}

const CHUNK = 10_000; // well under Postgres' 65,535 bind-parameter cap

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

// email_norm -> person id, for every address the org holds a person for. Reads
// the primary column AND person_emails, so a person is found by any address.
export async function personIdsByEmail(
  exec: Exec,
  orgId: string,
  emailNorms: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const norms = [...new Set(emailNorms)];
  for (const chunk of chunks(norms)) {
    const [primaries, extras] = await Promise.all([
      exec
        .select({ personId: people.id, emailNorm: people.emailNorm })
        .from(people)
        .where(and(eq(people.orgId, orgId), inArray(people.emailNorm, chunk))),
      exec
        .select({ personId: personEmails.personId, emailNorm: personEmails.emailNorm })
        .from(personEmails)
        .where(and(eq(personEmails.orgId, orgId), inArray(personEmails.emailNorm, chunk))),
    ]);
    for (const r of primaries) out.set(r.emailNorm as string, r.personId);
    for (const r of extras) if (!out.has(r.emailNorm)) out.set(r.emailNorm, r.personId);
  }
  return out;
}

// Every address of each person, primary first, then in the order they joined.
export async function emailsOfPersons(
  exec: Exec,
  personIds: string[]
): Promise<Map<string, PersonEmailView[]>> {
  const out = new Map<string, PersonEmailView[]>();
  const ids = [...new Set(personIds)];
  for (const chunk of chunks(ids)) {
    const [prim, rows] = await Promise.all([
      exec
        .select({
          id: people.id,
          emailNorm: people.emailNorm,
          companyDomain: people.companyDomain,
          companyName: people.companyName,
          firstSeenAt: people.firstSeenAt,
        })
        .from(people)
        .where(inArray(people.id, chunk)),
      exec
        .select()
        .from(personEmails)
        .where(inArray(personEmails.personId, chunk))
        .orderBy(asc(personEmails.createdAt), asc(personEmails.emailNorm)),
    ]);
    const primaryOf = new Map(prim.map((p) => [p.id, p]));
    for (const p of prim) {
      // A primary address with no person_emails row (written before 0040 ran on
      // this row, or by a path that bypassed it) is still the person's address.
      if (p.emailNorm && !rows.some((r) => r.personId === p.id && r.emailNorm === p.emailNorm)) {
        out.set(p.id, [
          {
            email: p.emailNorm,
            primary: true,
            companyDomain: p.companyDomain,
            companyName: p.companyName,
            source: "served",
            addedAt: p.firstSeenAt.toISOString(),
          },
        ]);
      }
    }
    for (const r of rows) {
      const list = out.get(r.personId) ?? [];
      list.push({
        email: r.emailNorm,
        primary: primaryOf.get(r.personId)?.emailNorm === r.emailNorm,
        companyDomain: r.companyDomain,
        companyName: r.companyName,
        source: r.source as PersonEmailSource,
        addedAt: r.createdAt.toISOString(),
      });
      out.set(r.personId, list);
    }
  }
  for (const list of out.values()) list.sort((a, b) => Number(b.primary) - Number(a.primary));
  return out;
}

// Every address of the people owning these addresses, the inputs included. An
// address no person holds stands for itself. This is what makes a fact stated on
// one address (suppression, opt-out, won) hold for the person.
export async function personAddressSet(
  exec: Exec,
  orgId: string,
  emailNorms: string[]
): Promise<string[]> {
  const norms = [...new Set(emailNorms)];
  if (norms.length === 0) return [];
  const owners = await personIdsByEmail(exec, orgId, norms);
  if (owners.size === 0) return norms;
  const all = new Set(norms);
  const emails = await emailsOfPersons(exec, [...new Set(owners.values())]);
  for (const list of emails.values()) for (const e of list) all.add(e.email);
  return [...all];
}

// Record that the gateway saw this address on this person (a serve / reveal).
// An address already held (by this person or, rarely, another) is left as is.
export async function recordServedEmail(
  exec: Exec,
  orgId: string,
  personId: string,
  emailNorm: string,
  companyDomain: string | null
): Promise<void> {
  await exec
    .insert(personEmails)
    .values({ orgId, personId, emailNorm, companyDomain, source: "served" })
    .onConflictDoNothing({ target: [personEmails.orgId, personEmails.emailNorm] });
}

export interface PersonWithEmails {
  personId: string;
  orgId: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  primaryEmail: string | null;
  emails: PersonEmailView[];
}

export async function getPersonWithEmails(
  orgId: string,
  personId: string
): Promise<PersonWithEmails | null> {
  const [p] = await db
    .select()
    .from(people)
    .where(and(eq(people.orgId, orgId), eq(people.id, personId)))
    .limit(1);
  if (!p) return null;
  const emails = (await emailsOfPersons(db, [p.id])).get(p.id) ?? [];
  return {
    personId: p.id,
    orgId: p.orgId,
    fullName: p.fullName,
    firstName: p.firstName,
    lastName: p.lastName,
    primaryEmail: p.emailNorm,
    emails,
  };
}

export async function findPersonByEmail(
  orgId: string,
  email: string
): Promise<PersonWithEmails | null> {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const personId = (await personIdsByEmail(db, orgId, [norm])).get(norm);
  return personId ? getPersonWithEmails(orgId, personId) : null;
}

export class PersonNotFoundError extends Error {}
export class EmailHeldByAnotherPersonError extends Error {
  constructor(readonly email: string, readonly otherPersonId: string) {
    super(`address ${email} already belongs to person ${otherPersonId}`);
  }
}

// Attach an extra address to an existing person: an explicit act, never a guess.
// Idempotent (the same address on the same person answers `attached: false`). An
// address another person already holds is refused (409): two people becoming one
// is a merge, and merging is not done by attaching an address.
export async function attachPersonEmail(args: {
  orgId: string;
  personId: string;
  email: string;
  companyDomain?: string | null;
  companyName?: string | null;
  evidence: string;
  attachedBy: string;
}): Promise<{ attached: boolean; person: PersonWithEmails }> {
  const norm = normalizeEmail(args.email);
  if (!norm) throw new Error("email is blank");
  const attached = await db.transaction(async (tx) => {
    const [p] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.orgId, args.orgId), eq(people.id, args.personId)))
      .for("update")
      .limit(1);
    if (!p) throw new PersonNotFoundError(args.personId);
    const owner = (await personIdsByEmail(tx, args.orgId, [norm])).get(norm);
    if (owner === args.personId) return false;
    if (owner) throw new EmailHeldByAnotherPersonError(norm, owner);
    const inserted = await tx
      .insert(personEmails)
      .values({
        orgId: args.orgId,
        personId: args.personId,
        emailNorm: norm,
        companyDomain: args.companyDomain?.trim().toLowerCase() || null,
        companyName: args.companyName?.trim() || null,
        source: "attached",
        evidence: args.evidence,
        attachedBy: args.attachedBy,
      })
      .onConflictDoNothing({ target: [personEmails.orgId, personEmails.emailNorm] })
      .returning({ personId: personEmails.personId });
    if (inserted.length === 0) {
      // A concurrent attach / serve took the address between the read and the write.
      const now = (await personIdsByEmail(tx, args.orgId, [norm])).get(norm);
      if (now && now !== args.personId) throw new EmailHeldByAnotherPersonError(norm, now);
      return false;
    }
    console.log(
      `[human-service] person_email.attached org=${args.orgId} person=${args.personId} by=${args.attachedBy}`
    );
    return true;
  });
  const person = await getPersonWithEmails(args.orgId, args.personId);
  if (!person) throw new PersonNotFoundError(args.personId);
  return { attached, person };
}
