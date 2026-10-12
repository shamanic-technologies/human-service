// STILL FITS — does this person STILL belong to this audience, right now?
// (STILL-FITS-1012, asked by lead-service at handover.)
//
// lead-service hands a lead out of a source's STOCK to an outreach pipe hours
// after the source found it. By then the person may have left the audience
// (Distribute.you 2026-10-12: 3 "signed up, never answered" people had WhatsApp
// threads merged into them after the find, and were still handed to WhatsApp
// outreach). lead-service never re-grades membership; it asks here, and each
// audience KIND answers the way that kind decides fit:
//
//   - CRM audiences (provider 'crm': people pool under `crm_people_filter`, one
//     imported file `crm_upload_id`, or the brand's whole imported list): the
//     pool rule is crm-service's, so crm-service judges it TODAY
//     (POST /orgs/contacts/still-fits, the SAME clauses its serve applies).
//     Never re-implemented here.
//   - Search audiences (apollo / apify, criteria and signal lists alike): fit was
//     decided at find time by the provider's search on the person's title and
//     company (and, for apollo, the pre-pay screen). Re-deciding it would mean a
//     paid re-search / re-enrich, which this read must never buy. So it answers
//     from what it holds: the person is a member this audience FOUND (any
//     provenance) and has not been screened out of it since. Not a member = we
//     cannot judge (fail loud), never a silent "fits".
//
// A QUESTION, not a serve: nothing is marked served or suppressed, nothing is
// bought, no membership is written.
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { audienceMembers, audiences, audienceScreenedOut, people } from "../db/schema.js";
import { crmStillFits } from "../lib/crm-contacts.js";
import { normalizeEmail } from "./suppression.js";
import { emailsOfPersons, personIdsByEmail } from "./person-emails.js";

export type StillFitsBasis = "crm_people_pool" | "crm_list" | "found_by_search";

export type StillFitsAnswer =
  | { fits: true; basis: StillFitsBasis }
  | { fits: false; basis: StillFitsBasis; reason: string; failed: { code: string; reason: string }[] };

export class StillFitsAudienceNotFoundError extends Error {
  constructor() {
    super("Audience not found for this org and brand");
    this.name = "StillFitsAudienceNotFoundError";
  }
}

// We cannot judge this person (unknown to the audience's owner): the caller must
// treat it as an error, never as "fits".
export class CannotJudgeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "CannotJudgeError";
  }
}

export interface StillFitsQuestion {
  orgId: string;
  brandId: string;
  audienceId: string;
  email: string;
  personId: string | null;
}

export async function audienceStillFits(q: StillFitsQuestion): Promise<StillFitsAnswer> {
  const [audience] = await db
    .select()
    .from(audiences)
    .where(and(eq(audiences.id, q.audienceId), eq(audiences.orgId, q.orgId), eq(audiences.brandId, q.brandId)))
    .limit(1);
  if (!audience) throw new StillFitsAudienceNotFoundError();

  const isCrm = audience.provider === "crm" || !!audience.crmUploadId || !!audience.crmPeopleFilter;
  if (isCrm) return crmFit(q, audience);
  return searchFit(q, audience.id);
}

// Every address we know for the person (the asked one first), so crm-service
// can find them by whichever address its own person holds.
async function addressesToAsk(q: StillFitsQuestion): Promise<string[]> {
  const asked = q.email.trim();
  const out = [asked];
  const personId = await resolvePersonId(q);
  if (personId) {
    const emails = (await emailsOfPersons(db, [personId])).get(personId) ?? [];
    for (const { email: addr } of emails) {
      if (addr && !out.some((x) => x.toLowerCase() === addr.toLowerCase())) out.push(addr);
    }
  }
  return out;
}

async function crmFit(q: StillFitsQuestion, audience: typeof audiences.$inferSelect): Promise<StillFitsAnswer> {
  const basis: StillFitsBasis = audience.crmPeopleFilter ? "crm_people_pool" : "crm_list";
  const scope = audience.crmPeopleFilter
    ? { people: audience.crmPeopleFilter }
    : audience.crmUploadId
      ? { uploadIds: [audience.crmUploadId] }
      : {};
  for (const email of await addressesToAsk(q)) {
    const answer = await crmStillFits(audience.brandId, email, scope, { orgId: q.orgId });
    if (answer === null) continue; // crm-service holds nobody at this address: try the next one
    if (answer.fits) return { fits: true, basis };
    return { fits: false, basis, reason: answer.reason, failed: answer.failed };
  }
  throw new CannotJudgeError(
    "person_unknown_to_crm",
    "The brand's CRM holds no person at this address, so this audience cannot say whether they still fit"
  );
}

async function resolvePersonId(q: StillFitsQuestion): Promise<string | null> {
  if (q.personId) {
    const [p] = await db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, q.personId), eq(people.orgId, q.orgId)))
      .limit(1);
    if (p) return p.id;
  }
  const norm = normalizeEmail(q.email);
  if (!norm) return null;
  return (await personIdsByEmail(db, q.orgId, [norm])).get(norm) ?? null;
}

async function searchFit(q: StillFitsQuestion, audienceId: string): Promise<StillFitsAnswer> {
  const personId = await resolvePersonId(q);
  if (!personId) {
    throw new CannotJudgeError("person_unknown", "No person of this org holds this address, so this audience cannot say whether they still fit");
  }
  // The audience itself, plus any deprecated provider-variant that resolves to it
  // (a person found under "<name> [Apify]" was found by this audience's lineage).
  const lineage = await db
    .select({ id: audiences.id })
    .from(audiences)
    .where(or(eq(audiences.id, audienceId), eq(audiences.canonicalAudienceId, audienceId)));
  const ids = lineage.map((r) => r.id);
  const [member] = await db
    .select({ id: audienceMembers.id })
    .from(audienceMembers)
    .where(and(eq(audienceMembers.personId, personId), inArray(audienceMembers.audienceId, ids)))
    .limit(1);
  if (!member) {
    throw new CannotJudgeError("not_found_by_audience", "This audience never found this person, so it cannot say whether they still fit");
  }
  // Screened out of this audience since (a candidate declined, a screen verdict):
  // keyed on the provider's person id.
  const [screened] = await db
    .select({ reason: audienceScreenedOut.reason })
    .from(audienceScreenedOut)
    .innerJoin(people, eq(people.id, personId))
    .where(
      and(
        inArray(audienceScreenedOut.audienceId, ids),
        sql`${audienceScreenedOut.providerPersonId} IN (${people.apolloPersonId}, ${people.apifyPersonId})`
      )
    )
    .limit(1);
  if (screened) {
    const reason = "Judged outside this audience's target since being found";
    return { fits: false, basis: "found_by_search", reason, failed: [{ code: "screened_out", reason }] };
  }
  return { fits: true, basis: "found_by_search" };
}
