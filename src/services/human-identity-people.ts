// Every per-org person hangs off a fleet-wide human (LEAD-REFONTE-1013).
//
// `people` stays one row per org (audiences, serves, suppression read it
// unchanged); `people.human_id` names the atomic human it is. This sweep is the
// ONLY writer of that column, so the serve path pays nothing and cannot fail on
// the identity layer: a person served now is linked on the next tick.
//
// What a person brings:
//   - its primary address and every SERVED address (the gateway saw the provider
//     reveal them on this person): proof keys, so the same address held by a
//     person of another org is the same human, fleet-wide;
//   - its LinkedIn URL and provider person ids: resolve only;
//   - an ATTACHED address (an org's explicit statement, person-emails.ts): a
//     judgment, so it never joins the fleet human. It gets its own human (or the
//     one already holding it) and an org-scoped 'same' link the org alone sees.
//
// Also picks up an address a linked person gained since (a new served or attached
// row whose key nobody holds yet). Idempotent: a person whose keys are all held
// by its human changes nothing.
//
// Boot safety: nothing is awaited before `app.listen()`; timers only.
import { asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { humanLinks, people, personEmails, type Person } from "../db/schema.js";
import { getMigrationState } from "../lib/migration-state.js";
import {
  canonicalOf,
  componentOf,
  emit,
  lockIdentityWrites,
  resolveIdentityTx,
  type IdentityKey,
} from "./human-identity.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const SOURCE = "human-service:people";
const BATCH = 200;
const DEFAULT_MAX_BATCHES = 400; // 80k people a run: the whole table on 2026-10-13 was 44.5k
const DEFAULT_INITIAL_DELAY_MS = 60_000;
const DEFAULT_INTERVAL_MS = 2 * 60_000;

export interface LinkPeopleResult {
  dryRun: boolean;
  // People that had no human and now have one (dry run: would).
  linkedPeople: number;
  // Linked people revisited for an address their human did not hold yet.
  revisitedPeople: number;
  humansCreated: number;
  fleetMerges: number;
  orgLinks: number;
  hasMore: boolean;
}

function personKeys(p: Person, served: string[]): IdentityKey[] {
  const keys: IdentityKey[] = [];
  if (p.emailNorm) keys.push({ kind: "email", valueNorm: p.emailNorm });
  for (const e of served) if (e !== p.emailNorm) keys.push({ kind: "email", valueNorm: e });
  if (p.linkedinUrlNorm) keys.push({ kind: "linkedin_url", valueNorm: p.linkedinUrlNorm });
  if (p.apolloPersonId) keys.push({ kind: "apollo_person_id", valueNorm: p.apolloPersonId });
  if (p.apifyPersonId) keys.push({ kind: "apify_person_id", valueNorm: p.apifyPersonId });
  return keys;
}

async function linkPerson(
  tx: Tx,
  p: Person,
  addresses: Array<{ emailNorm: string; source: string; evidence: string | null; attachedBy: string | null }>,
  totals: LinkPeopleResult
): Promise<void> {
  const served = addresses.filter((a) => a.source !== "attached").map((a) => a.emailNorm);
  const resolved = await resolveIdentityTx(tx, {
    orgId: null,
    keys: personKeys(p, served),
    source: SOURCE,
    create: true,
  });
  const anchor = resolved.atomicHumanId as string;
  if (resolved.created) totals.humansCreated++;
  totals.fleetMerges += resolved.mergedHumanIds.length;

  for (const a of addresses.filter((x) => x.source === "attached")) {
    const held = await resolveIdentityTx(tx, {
      orgId: p.orgId,
      keys: [{ kind: "email", valueNorm: a.emailNorm }],
      source: `${SOURCE}:attached`,
      create: true,
    });
    if (held.created) totals.humansCreated++;
    const other = held.atomicHumanId as string;
    const comp = await componentOf(tx, anchor, p.orgId);
    if (comp.includes(other)) continue;
    const [x, y] = anchor < other ? [anchor, other] : [other, anchor];
    const [link] = await tx
      .insert(humanLinks)
      .values({
        relation: "same",
        scope: "org",
        orgId: p.orgId,
        aHumanId: x,
        bHumanId: y,
        basis: "judgment",
        judgedBy: a.attachedBy ?? "unknown",
        statedBy: "person-emails:attached",
        evidence: a.evidence ?? `address ${a.emailNorm} attached to person ${p.id}`,
      })
      .returning({ id: humanLinks.id });
    const view = await canonicalOf(tx, anchor, p.orgId);
    await emit(tx, "human.linked", p.orgId, [x, y], {
      linkId: link.id,
      relation: "same",
      scope: "org",
      basis: "judgment",
      humanId: view.humanId,
      memberHumanIds: view.memberHumanIds,
    });
    totals.orgLinks++;
  }

  if (p.humanId === null) {
    await tx.update(people).set({ humanId: anchor }).where(eq(people.id, p.id));
  }
}

async function addressesOf(tx: Tx, personIds: string[]) {
  const rows = await tx
    .select({
      personId: personEmails.personId,
      emailNorm: personEmails.emailNorm,
      source: personEmails.source,
      evidence: personEmails.evidence,
      attachedBy: personEmails.attachedBy,
    })
    .from(personEmails)
    .where(inArray(personEmails.personId, personIds))
    .orderBy(asc(personEmails.createdAt), asc(personEmails.emailNorm));
  const out = new Map<string, typeof rows>();
  for (const r of rows) out.set(r.personId, [...(out.get(r.personId) ?? []), r]);
  return out;
}

// Linked people holding an address no human holds yet.
async function revisitIds(exec: typeof db | Tx, limit: number): Promise<string[]> {
  const r = (await exec.execute(sql`
    SELECT DISTINCT pe.person_id AS id
    FROM person_emails pe JOIN people p ON p.id = pe.person_id
    WHERE p.human_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM human_identity_keys k WHERE k.kind = 'email' AND k.value_norm = pe.email_norm)
    LIMIT ${limit}`)) as unknown as Array<{ id: string }>;
  return r.map((x) => x.id);
}

export async function linkPeopleToHumans(opts: {
  dryRun: boolean;
  maxBatches?: number;
}): Promise<LinkPeopleResult> {
  const totals: LinkPeopleResult = {
    dryRun: opts.dryRun,
    linkedPeople: 0,
    revisitedPeople: 0,
    humansCreated: 0,
    fleetMerges: 0,
    orgLinks: 0,
    hasMore: false,
  };
  if (opts.dryRun) {
    const [{ n }] = (await db.execute(
      sql`SELECT count(*)::int AS n FROM people WHERE human_id IS NULL`
    )) as unknown as Array<{ n: number }>;
    totals.linkedPeople = n;
    totals.revisitedPeople = (await revisitIds(db, 100_000)).length;
    return totals;
  }
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
  for (let i = 0; i < maxBatches; i++) {
    const done = await db.transaction(async (tx) => {
      await lockIdentityWrites(tx);
      let batch = await tx
        .select()
        .from(people)
        .where(isNull(people.humanId))
        .orderBy(asc(people.id))
        .limit(BATCH);
      let revisit = false;
      if (batch.length === 0) {
        const ids = await revisitIds(tx, BATCH);
        if (ids.length === 0) return true;
        batch = await tx.select().from(people).where(inArray(people.id, ids));
        revisit = true;
      }
      const addresses = await addressesOf(tx, batch.map((p) => p.id));
      for (const p of batch) await linkPerson(tx, p, addresses.get(p.id) ?? [], totals);
      if (revisit) totals.revisitedPeople += batch.length;
      else totals.linkedPeople += batch.length;
      return false;
    });
    if (done) return totals;
  }
  totals.hasMore = true;
  return totals;
}

// --- cadence ---

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[human-service] ${name}=${raw} is not a number of ms; using ${fallback}`);
    return fallback;
  }
  return n;
}

let running = false;

export async function runHumanLinkTick(): Promise<void> {
  if (running) return;
  if (getMigrationState() !== "ready") return;
  running = true;
  try {
    const r = await linkPeopleToHumans({ dryRun: false });
    if (r.linkedPeople || r.revisitedPeople) {
      console.log(
        `[human-service] human_identity.people_linked linked=${r.linkedPeople} revisited=${r.revisitedPeople} created=${r.humansCreated} fleetMerges=${r.fleetMerges} orgLinks=${r.orgLinks} hasMore=${r.hasMore}`
      );
    }
  } catch (err) {
    console.error("[human-service] human_identity.people_link_failed", err);
  } finally {
    running = false;
  }
}

export function startHumanLinkSweep(): void {
  const interval = envMs("HUMAN_IDENTITY_LINK_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  if (interval === 0) {
    console.log("[human-service] human identity people link sweep disabled");
    return;
  }
  const initial = envMs("HUMAN_IDENTITY_LINK_INITIAL_DELAY_MS", DEFAULT_INITIAL_DELAY_MS);
  setTimeout(() => {
    void runHumanLinkTick();
    setInterval(() => void runHumanLinkTick(), interval).unref();
  }, initial).unref();
}

