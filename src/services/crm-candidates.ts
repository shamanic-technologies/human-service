// CRM candidates — a CRM-served person is QUALIFIED before anything is paid for
// them, like a person from every other source (CRM-SERVE-FIND-EMAIL-1021).
//
// WHY. A client adds people they know to their CRM (Copilot, API, MCP), often
// with a name, a company and a LinkedIn but no email (crm-service
// CRM-ADD-ONE-CONTACT-1021). Before this, the CRM serve dropped anyone without an
// email, and nobody screened a CRM person against the brand's target or the
// offer's must-pass checks. Now the CRM pipe goes through the SAME candidate
// frontier as apollo (audience-candidates.ts), so lead-service's screen and
// qualification apply unchanged:
//   next    → crm-service hands out the next contact (`includeEmailUnknown` on the
//             CSV pool: an email-unknown contact comes after the sendable ones),
//             the free gates apply (opt-outs, own company, bounces), and it is
//             offered as a candidate. No spend.
//   reveal  → a contact WITH an email: served as before, free. WITHOUT one: the
//             email is looked up NOW (apollo-service email finder, billed by
//             apollo-service on the campaign's serve run, never twice for one
//             person) and written back to crm-service (found / not_found). Found
//             and accepted by the caller's email policy ⟹ served; else not_served
//             and the next candidate is asked for.
//   decline → audience-candidates.ts' decline, unchanged.
//
// Owner 2026-10-21: adding contacts is free; a paid lookup only when a campaign
// serves the person, billed to that campaign. A contact no campaign serves is
// never looked up, and the lookup sits AFTER lead-service's qualification.
//
// crm-service burns a SENDABLE contact on hand-out (unchanged): a declined one is
// gone for the brand, as when serve-next dropped it. An email-unknown contact is
// recorded handed-out there and comes back after 24 h if nobody wrote back; our
// (audience, contact) candidate row makes that second hand-out a free skip.

import { db } from "../db/index.js";
import { audienceCandidates, type AudienceCandidate, type audiences, type TeaserSnapshot } from "../db/schema.js";
import {
  crmServeNext,
  crmWriteEmailLookup,
  normalizeCrmContact,
  type CrmContact,
} from "../lib/crm-contacts.js";
import { findablePerson, findEmail, normalizeDomain } from "../lib/email-finder.js";
import {
  isVerdictAccepted,
  readEmailVerification,
  type EmailVerdict,
} from "../lib/email-verification.js";
import { normalizeReach, personReaches, type Reach } from "../lib/reach.js";
import { loadOptOutExclusions, matchesOptOut } from "./opt-outs.js";
import { isEmailBounced } from "./bounces.js";
import { isOwnCompany, isOwnCompanyPerson, loadOwnCompany } from "./own-company.js";
import { hasUsableEmail, servedWithPersonId } from "./audiences.js";
import { screenTarget } from "./audience-target-text.js";
import type { Identity, Person } from "./people-providers.js";

type AudienceRow = typeof audiences.$inferSelect;

export type CrmRevealReason =
  | "email_not_found" // the lookup ran (or could not run: nothing to find it with) and found no address
  | "email_lookup_pending" // the finder is still working; the candidate is offered again later
  | "not_deliverable"
  | "opted_out"
  | "own_company"
  | "bounced"
  | "no_email";

export interface CrmRevealResult {
  status: "served" | "not_served";
  person: Person | null;
  personId?: string;
  emailVerdict?: EmailVerdict | null;
  reason?: CrmRevealReason;
  verdict?: string;
  // On email_lookup_pending: the candidate goes back to `offered`, nothing stored.
  handBack?: boolean;
}

export interface CrmCandidateServeOptions {
  reach: readonly Reach[];
}

// The judgeable snapshot of a CRM contact: what the client told us about them.
// Absent stays absent (crm carries no geography, seniority or firmographics).
export function crmTeaser(c: CrmContact): TeaserSnapshot {
  const name = c.fullName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || null);
  return {
    name,
    title: c.jobTitle ?? null,
    headline: null,
    seniority: null,
    city: null,
    state: null,
    country: null,
    organizationName: c.companyName ?? null,
    organizationIndustry: null,
    organizationEmployees: null,
    organizationCity: null,
    organizationState: null,
    organizationCountry: null,
    organizationKeywords: null,
  };
}

function isEmailUnknown(c: CrmContact): boolean {
  return !c.primaryEmail?.trim() && c.emailStatus === "unknown";
}

// The served-contract reach (served ⇒ usable email) rides with any stated reach,
// exactly as serve-next asks crm-service (see serveNextCrmContact).
function crmReachOf(reach: readonly Reach[]): Reach[] {
  return reach.length > 0 ? normalizeReach([...reach, "email"]) : [];
}

function crmIdentityOf(audience: AudienceRow, identity: Identity): Identity {
  return {
    ...identity,
    workflowTracking: { ...(identity.workflowTracking ?? {}), audienceId: audience.id },
  };
}

/**
 * The next CRM candidate of an audience. `retakeLapsed` re-offers a candidate
 * whose caller never decided (shared with the apollo path).
 */
export async function nextCrmCandidate(
  audience: AudienceRow,
  identity: Identity,
  opts: CrmCandidateServeOptions,
  retakeLapsed: () => Promise<AudienceCandidate | null>
): Promise<
  | { status: "candidate"; row: AudienceCandidate; target: ReturnType<typeof screenTarget> }
  | { status: "exhausted"; target: ReturnType<typeof screenTarget> }
> {
  const target = screenTarget(audience);
  const lapsed = await retakeLapsed();
  if (lapsed) return { status: "candidate", row: lapsed, target };

  const crmReach = crmReachOf(opts.reach);
  const crmIdentity = crmIdentityOf(audience, identity);
  const optOuts = await loadOptOutExclusions(identity);
  const ownCompany = await loadOwnCompany(identity.orgId, [audience.brandId]);
  // The people pool refuses `includeEmailUnknown` (crm-service: CSV pool only).
  const includeEmailUnknown = !audience.crmPeopleFilter;

  for (;;) {
    const { contacts } = await crmServeNext(audience.brandId, 1, crmIdentity, {
      uploadId: audience.crmUploadId,
      people: audience.crmPeopleFilter,
      reachableBy: crmReach,
      relationships: identity.relationships ?? null,
      stepFilter: identity.stepFilter ?? null,
      includeEmailUnknown,
    });
    const contact = contacts[0] ?? null;
    if (!contact) return { status: "exhausted", target };

    const person = normalizeCrmContact(contact);
    const unknown = isEmailUnknown(contact);
    if (!unknown && !hasUsableEmail(person)) continue; // already burned there, never servable
    if (matchesOptOut(optOuts, { email: person.email, linkedinUrl: contact.linkedinUrl ?? null })) {
      console.log(`[human-service] opt_out.blocked_crm_candidate org=${identity.orgId} audience=${audience.id}`);
      continue;
    }
    if (
      isOwnCompanyPerson(ownCompany, person) ||
      isOwnCompany(ownCompany, { name: contact.companyName ?? null, domain: normalizeDomain(contact.companyDomain) })
    ) {
      console.log(`[human-service] own_company.blocked_crm_candidate org=${identity.orgId} audience=${audience.id}`);
      continue;
    }
    if (!unknown && (await isEmailBounced(identity, person.email))) {
      console.log(`[human-service] bounce.blocked_crm_candidate org=${identity.orgId} audience=${audience.id}`);
      continue;
    }
    if (!unknown && !personReaches(person, crmReach)) {
      console.error(
        `[human-service] reach.crm_contract_break org=${identity.orgId} audience=${audience.id} reach=${crmReach.join(",")} path=candidates`
      );
      continue;
    }

    const [row] = await db
      .insert(audienceCandidates)
      .values({
        orgId: identity.orgId,
        audienceId: audience.id,
        providerPersonId: contact.id,
        linkedinUrl: contact.linkedinUrl ?? null,
        teaser: crmTeaser(contact),
        organizationDomain: normalizeDomain(contact.companyDomain),
        crmContact: contact,
      })
      .onConflictDoNothing({ target: [audienceCandidates.audienceId, audienceCandidates.providerPersonId] })
      .returning();
    // Already offered / decided for this audience (an email-unknown contact
    // handed out again after its 24 h TTL): never twice.
    if (!row) continue;
    console.log(
      `[human-service] audience.crm_candidate_offered org=${identity.orgId} audience=${audience.id} candidate=${row.id} email=${unknown ? "unknown" : "known"}`
    );
    return { status: "candidate", row, target };
  }
}

/**
 * Reveal a CRM candidate: free when the contact has an email; otherwise the
 * email lookup, billed by apollo-service on this serve's run, then written back.
 */
export async function revealCrmCandidate(
  audience: AudienceRow,
  identity: Identity,
  row: AudienceCandidate
): Promise<CrmRevealResult> {
  const contact = row.crmContact!;
  const base = normalizeCrmContact(contact);
  if (hasUsableEmail(base)) {
    const served = await servedWithPersonId(identity.orgId, audience.id, base);
    return { status: "served", person: served.person, personId: served.personId, emailVerdict: null };
  }

  const crmIdentity = crmIdentityOf(audience, identity);
  const findable = findablePerson(contact);
  if (!findable) {
    // Nothing a finder can take (a company NAME alone): no spend, never handed out again.
    await crmWriteEmailLookup(contact.id, audience.brandId, { status: "not_found" }, crmIdentity);
    console.log(`[human-service] crm_email_lookup.not_findable org=${identity.orgId} audience=${audience.id} contact=${contact.id}`);
    return { status: "not_served", person: null, reason: "email_not_found" };
  }

  const found = await findEmail(findable, identity);
  console.log(
    `[human-service] crm_email_lookup org=${identity.orgId} audience=${audience.id} contact=${contact.id} status=${found.status}${"reused" in found ? ` reused=${found.reused}` : ""}`
  );
  if (found.status === "pending") {
    return { status: "not_served", person: null, reason: "email_lookup_pending", handBack: true };
  }
  if (found.status === "not_found") {
    await crmWriteEmailLookup(contact.id, audience.brandId, { status: "not_found" }, crmIdentity);
    return { status: "not_served", person: null, reason: "email_not_found" };
  }

  // Found: crm-service gets the address and marks it served for the brand (the
  // hand-out was its serve), so whatever we decide below it is never re-served.
  const verification = readEmailVerification("apollo", found.emailVerification, found.email);
  await crmWriteEmailLookup(contact.id, audience.brandId, { status: "found", email: found.email }, crmIdentity);
  const person: Person = { ...base, email: found.email };
  if (verification && !isVerdictAccepted(verification, identity.acceptedEmails)) {
    return { status: "not_served", person: null, reason: "not_deliverable", verdict: verification.verdict };
  }
  const optOuts = await loadOptOutExclusions(identity);
  if (matchesOptOut(optOuts, { email: person.email })) {
    return { status: "not_served", person: null, reason: "opted_out" };
  }
  const ownCompany = await loadOwnCompany(identity.orgId, [audience.brandId]);
  if (isOwnCompanyPerson(ownCompany, person)) {
    return { status: "not_served", person: null, reason: "own_company" };
  }
  if (await isEmailBounced(identity, person.email)) {
    return { status: "not_served", person: null, reason: "bounced" };
  }
  const served = await servedWithPersonId(
    identity.orgId,
    audience.id,
    person,
    verification?.verdict ?? null
  );
  return {
    status: "served",
    person: served.person,
    personId: served.personId,
    emailVerdict: verification?.verdict ?? null,
  };
}
