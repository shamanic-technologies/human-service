// Re-reach of catch-all people already paid for (CATCHALL-SERVE-OPTION-1013).
// Same for unknown-verdict people under `valid_catch_all_and_unknown`
// (UNKNOWN-EMAILS-OPTION-1014): the verdicts looked for are the caller's
// `widenedVerdicts`, and each person is handed with their OWN verdict.
//
// WHY. Until a caller could ask for catch-all addresses, every revealed person
// whose address verified `catch_all` was CLAIMED for the brand (bronze
// `lead_serves` row with `email_verdict = 'catch_all'` + silver
// `brand_suppressions`) and dropped: never handed, never re-bought. Their
// address was revealed and verified, and both were paid for. A serve that now
// asks `acceptedEmails: "valid_and_catch_all"` hands them out from what we
// stored, before revealing anyone new: no reveal, no verification, no charge.
//
// THE POPULATION (one statement, `selectRereachable`): a bronze serve of THIS
// audience for THIS brand whose verdict is catch_all, from a provider that
// verifies (apollo), with an address and an apollo person id, and
//   - never handed for the brand: no `served` audience membership of the
//     person (at any of their addresses) under any audience of the brand
//     (a handed person is tagged; a dropped one never was),
//   - no LATER verdict on the same address for the brand other than catch_all
//     (a re-verification that said unknown / invalid wins),
//   - not rejected for the audience since (`audience_screened_out`),
//   - not re-reached already (`catch_all_rereaches`, unique per org + brand +
//     address: each person ONCE, whichever path or audience),
//   - not an open candidate of the audience right now.
// Keyed on the audience that found them: that audience's filters (and its
// screen, or lead-service's qualification) put them there, so they are handed
// under it and nowhere else.
//
// THE PERSON is rebuilt from what we hold: the bronze serve (names, address,
// LinkedIn, employer domain, apollo id) and the teaser snapshot the audience
// judged (title, seniority, geography, employer facts). Never a provider call.
// What only a reveal carries (timezone, employment history, buying signal) is
// null: absence stays absence.
//
// GATES at hand-out time, the post-reveal ones a fresh reveal passes (opt-out,
// won / never-cold-contact, own company, hard bounce), read live. A blocked
// person is recorded `blocked` and never offered again.

import { sql as pg } from "../db/index.js";
import type { TeaserSnapshot } from "../db/schema.js";
import { deriveBusinessLanguages } from "./business-languages.js";
import {
  NO_ORGANIZATION_FACTS,
  type Identity,
  type Person,
  type RevealBlockReason,
} from "./people-providers.js";
import { isEmailWonForRequest, isPersonOptedOut } from "./opt-outs.js";
import { isOwnCompanyPerson, loadOwnCompany } from "./own-company.js";
import { isEmailBounced } from "./bounces.js";
import { normalizeEmail } from "./suppression.js";
import { widenedVerdicts, type EmailVerdict } from "../lib/email-verification.js";

export type RereachPath = "serve_next" | "candidates";
export type RereachStatus = "claimed" | "offered" | "handed" | "blocked" | "declined";

export interface RereachableServe {
  leadServeId: string;
  providerPersonId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  emailNorm: string;
  linkedinUrl: string | null;
  companyDomain: string | null;
  teaser: TeaserSnapshot | null;
  teaserDomain: string | null;
  // The audience's candidate row for this person, when the candidate path saw
  // them before (a revealed `not_served` row): re-offered in place.
  candidateId: string | null;
  // The verdict the paid verification gave this address (catch_all, unknown).
  verdict: EmailVerdict;
}

interface RereachRow {
  lead_serve_id: string;
  provider_person_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  linkedin_url: string | null;
  company_domain: string | null;
  teaser: TeaserSnapshot | null;
  teaser_domain: string | null;
  candidate_id: string | null;
  email_verdict: EmailVerdict;
}

// How many rows one read takes: a claim can lose a race or a gate can block,
// so the caller walks a few before asking again.
const REREACH_PAGE = 20;

/**
 * The next catch-all people of this audience a serve asking for catch-all may
 * re-reach, oldest serve first. Free (one read), claims nothing.
 */
export async function selectRereachable(
  orgId: string,
  brandId: string,
  audienceId: string,
  verdicts: readonly EmailVerdict[]
): Promise<RereachableServe[]> {
  if (verdicts.length === 0) return [];
  const rows = await pg<RereachRow[]>`
    SELECT ls.id AS lead_serve_id, ls.provider_person_id, ls.first_name, ls.last_name,
           ls.email, ls.linkedin_url, ls.company_domain, ls.email_verdict,
           COALESCE(ac.teaser, (
             SELECT s.teaser FROM audience_teaser_screenings s
              WHERE s.audience_id = ls.audience_id AND s.provider_person_id = ls.provider_person_id
              ORDER BY s.created_at DESC LIMIT 1
           )) AS teaser,
           ac.organization_domain AS teaser_domain,
           ac.id AS candidate_id
      FROM lead_serves ls
      LEFT JOIN audience_candidates ac
        ON ac.audience_id = ls.audience_id AND ac.provider_person_id = ls.provider_person_id
     WHERE ls.org_id = ${orgId}::uuid AND ls.brand_id = ${brandId}::uuid
       AND ls.audience_id = ${audienceId}::uuid
       AND ls.email_verdict IN ${pg(verdicts as EmailVerdict[])} AND ls.provider = 'apollo'
       AND ls.provider_person_id IS NOT NULL
       AND ls.email IS NOT NULL AND btrim(ls.email) <> ''
       AND (ac.id IS NULL OR ac.status = 'revealed')
       AND NOT EXISTS (
         SELECT 1 FROM catch_all_rereaches r
          WHERE r.org_id = ls.org_id AND r.brand_id = ls.brand_id
            AND r.email_norm = lower(btrim(ls.email)))
       AND NOT EXISTS (
         SELECT 1 FROM lead_serves o
          WHERE o.org_id = ls.org_id AND o.brand_id = ls.brand_id
            AND o.email_verdict IS NOT NULL AND o.email_verdict <> ls.email_verdict
            AND lower(btrim(o.email)) = lower(btrim(ls.email))
            AND o.served_at > ls.served_at)
       AND NOT EXISTS (
         SELECT 1 FROM audience_screened_out so
          WHERE so.audience_id = ls.audience_id AND so.provider_person_id = ls.provider_person_id)
       AND NOT EXISTS (
         SELECT 1 FROM audience_members m
           JOIN audiences a ON a.id = m.audience_id AND a.brand_id = ls.brand_id
          WHERE m.org_id = ls.org_id AND m.provenance = 'served'
            AND m.person_id IN (
              SELECT p.id FROM people p
               WHERE p.org_id = ls.org_id AND p.email_norm = lower(btrim(ls.email))
              UNION
              SELECT pe.person_id FROM person_emails pe
               WHERE pe.org_id = ls.org_id AND pe.email_norm = lower(btrim(ls.email))))
     ORDER BY ls.served_at ASC, ls.id ASC
     LIMIT ${REREACH_PAGE}
  `;
  return rows.map((r) => ({
    leadServeId: r.lead_serve_id,
    providerPersonId: r.provider_person_id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email.trim(),
    emailNorm: normalizeEmail(r.email) as string,
    linkedinUrl: r.linkedin_url,
    companyDomain: r.company_domain,
    teaser: r.teaser,
    teaserDomain: r.teaser_domain,
    candidateId: r.candidate_id,
    verdict: r.email_verdict,
  }));
}

/**
 * Claim a re-reach ONCE for the brand (unique org + brand + address). false ⟹
 * a concurrent serve took it first.
 */
export async function claimRereach(
  orgId: string,
  brandId: string,
  audienceId: string,
  serve: RereachableServe,
  path: RereachPath,
  status: Extract<RereachStatus, "claimed" | "offered">
): Promise<boolean> {
  const rows = await pg<{ id: string }[]>`
    INSERT INTO catch_all_rereaches
      (org_id, brand_id, audience_id, email_norm, provider_person_id, lead_serve_id, path, status)
    VALUES (${orgId}::uuid, ${brandId}::uuid, ${audienceId}::uuid, ${serve.emailNorm},
            ${serve.providerPersonId}, ${serve.leadServeId}::uuid, ${path}, ${status})
    ON CONFLICT (org_id, brand_id, email_norm) DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}

export async function setRereachCandidate(
  orgId: string,
  brandId: string,
  emailNorm: string,
  candidateId: string,
  previousRevealResult: unknown
): Promise<void> {
  await pg`
    UPDATE catch_all_rereaches
       SET candidate_id = ${candidateId}::uuid,
           previous_reveal_result = ${previousRevealResult === null || previousRevealResult === undefined ? null : JSON.stringify(previousRevealResult)}::jsonb
     WHERE org_id = ${orgId}::uuid AND brand_id = ${brandId}::uuid AND email_norm = ${emailNorm}
  `;
}

export async function markRereach(
  orgId: string,
  brandId: string,
  emailNorm: string,
  status: Exclude<RereachStatus, "claimed" | "offered">,
  blockReason: string | null = null
): Promise<void> {
  await pg`
    UPDATE catch_all_rereaches
       SET status = ${status}, block_reason = ${blockReason},
           decided_at = now()
     WHERE org_id = ${orgId}::uuid AND brand_id = ${brandId}::uuid AND email_norm = ${emailNorm}
  `;
}

// Gives a re-reach back (a reveal of it asked for valid only): the person stays
// re-reachable for a later serve that asks for catch-all.
export async function releaseRereach(orgId: string, brandId: string, emailNorm: string): Promise<void> {
  await pg`
    DELETE FROM catch_all_rereaches
     WHERE org_id = ${orgId}::uuid AND brand_id = ${brandId}::uuid AND email_norm = ${emailNorm}
  `;
}

/** The open re-reach a candidate row was (re-)offered for, if any. */
export async function rereachOfCandidate(candidateId: string): Promise<RereachableServe | null> {
  const rows = await pg<RereachRow[]>`
    SELECT ls.id AS lead_serve_id, ls.provider_person_id, ls.first_name, ls.last_name,
           ls.email, ls.linkedin_url, ls.company_domain, ls.email_verdict,
           COALESCE(ac.teaser, (
             SELECT s.teaser FROM audience_teaser_screenings s
              WHERE s.audience_id = ac.audience_id AND s.provider_person_id = ac.provider_person_id
              ORDER BY s.created_at DESC LIMIT 1
           )) AS teaser,
           ac.organization_domain AS teaser_domain, ac.id AS candidate_id
      FROM catch_all_rereaches r
      JOIN lead_serves ls ON ls.id = r.lead_serve_id
      JOIN audience_candidates ac ON ac.id = r.candidate_id
     WHERE r.candidate_id = ${candidateId}::uuid AND r.status = 'offered'
     LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    leadServeId: r.lead_serve_id,
    providerPersonId: r.provider_person_id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email.trim(),
    emailNorm: normalizeEmail(r.email) as string,
    linkedinUrl: r.linkedin_url,
    companyDomain: r.company_domain,
    teaser: r.teaser,
    teaserDomain: r.teaser_domain,
    candidateId: r.candidate_id,
    verdict: r.email_verdict,
  };
}

/** The person as we hold them: bronze serve + the teaser the audience judged. Pure. */
export function rereachPerson(serve: RereachableServe): Person {
  const t: Partial<TeaserSnapshot> = serve.teaser ?? {};
  const joined = [serve.firstName, serve.lastName].filter((x) => x && x.trim()).join(" ");
  const domain = serve.companyDomain ?? serve.teaserDomain ?? null;
  const hasOrg = !!(t.organizationName || domain || t.organizationIndustry);
  return {
    firstName: serve.firstName,
    lastName: serve.lastName,
    name: t.name ?? (joined || null),
    title: t.title ?? null,
    headline: t.headline ?? null,
    seniority: t.seniority ?? null,
    email: serve.email,
    emailStatus: null,
    // The verifier said so: the domain accepts every address (unknown: it could not tell).
    catchAll: serve.verdict === "catch_all" ? true : null,
    inferred: null,
    linkedinUrl: serve.linkedinUrl,
    photoUrl: null,
    city: t.city ?? null,
    state: t.state ?? null,
    country: t.country ?? null,
    timezone: null,
    businessLanguages: deriveBusinessLanguages(
      { city: t.city ?? null, state: t.state ?? null, country: t.country ?? null },
      {
        city: t.organizationCity ?? null,
        state: t.organizationState ?? null,
        country: t.organizationCountry ?? null,
      }
    ),
    provider: "apollo",
    providerPersonId: serve.providerPersonId,
    organization: hasOrg
      ? {
          name: t.organizationName ?? null,
          domain,
          websiteUrl: null,
          industry: t.organizationIndustry ?? null,
          estimatedNumEmployees: t.organizationEmployees ?? null,
          annualRevenue: null,
          linkedinUrl: null,
          logoUrl: null,
          city: t.organizationCity ?? null,
          state: t.organizationState ?? null,
          country: t.organizationCountry ?? null,
          ...NO_ORGANIZATION_FACTS,
          keywords: t.organizationKeywords ?? null,
        }
      : null,
    employmentHistory: null,
    buyingSignal: null,
  };
}

/**
 * The post-reveal gates a fresh reveal passes, read live, minus the brand
 * claim (this person IS the brand's claim). null ⟹ may be handed.
 */
export async function rereachBlock(
  identity: Identity,
  brandId: string,
  person: Person
): Promise<Extract<RevealBlockReason, "opted_out" | "won" | "own_company" | "bounced"> | null> {
  if (await isPersonOptedOut(identity, person.email)) return "opted_out";
  if (await isEmailWonForRequest(identity, person.email)) return "won";
  if (isOwnCompanyPerson(await loadOwnCompany(identity.orgId, [brandId]), person)) return "own_company";
  if (await isEmailBounced(identity, person.email)) return "bounced";
  return null;
}

/**
 * The hand-out itself: the brand's claim on the person restarts now (a real
 * serve happens now, so the no-repeat window counts from it), and the re-reach
 * is recorded `handed`. Membership is tagged by the caller (servedWithPersonId).
 */
export async function recordRereachHandout(
  orgId: string,
  brandId: string,
  serve: RereachableServe
): Promise<void> {
  await pg.begin(async (transaction) => {
    // postgres.js types a transaction as Omit<Sql, ...>, dropping the call
    // signature; it is callable at runtime exactly like `sql`.
    const tx = transaction as unknown as typeof pg;
    await tx`
      INSERT INTO brand_suppressions (org_id, brand_id, email_norm, provider_person_id, last_provider)
      VALUES (${orgId}::uuid, ${brandId}::uuid, ${serve.emailNorm}, ${serve.providerPersonId}, 'apollo')
      ON CONFLICT (org_id, brand_id, email_norm)
      DO UPDATE SET last_served_at = now()
    `;
    await tx`
      UPDATE catch_all_rereaches SET status = 'handed', decided_at = now()
       WHERE org_id = ${orgId}::uuid AND brand_id = ${brandId}::uuid AND email_norm = ${serve.emailNorm}
    `;
  });
}

/**
 * serve-next's re-reach: the oldest catch-all person of this audience, claimed
 * once, gated, handed. null ⟹ none left (the caller reveals someone new).
 */
export async function takeRereachForServe(
  identity: Identity,
  brandId: string,
  audienceId: string
): Promise<{ person: Person; serve: RereachableServe } | null> {
  for (;;) {
    const page = await selectRereachable(identity.orgId, brandId, audienceId, widenedVerdicts(identity.acceptedEmails));
    if (page.length === 0) return null;
    for (const serve of page) {
      if (!(await claimRereach(identity.orgId, brandId, audienceId, serve, "serve_next", "claimed"))) continue;
      const person = rereachPerson(serve);
      const block = await rereachBlock(identity, brandId, person);
      if (block) {
        await markRereach(identity.orgId, brandId, serve.emailNorm, "blocked", block);
        console.log(
          `[human-service] catch_all_rereach.blocked org=${identity.orgId} audience=${audienceId} reason=${block} path=serve_next`
        );
        continue;
      }
      await recordRereachHandout(identity.orgId, brandId, serve);
      console.log(
        `[human-service] catch_all_rereach.handed org=${identity.orgId} audience=${audienceId} leadServe=${serve.leadServeId} path=serve_next`
      );
      return { person, serve };
    }
  }
}

/** A decision on a re-offered candidate closes its re-reach. No re-reach ⟹ no-op. */
export async function markRereachOfCandidate(
  candidateId: string,
  status: Extract<RereachStatus, "declined">
): Promise<void> {
  await pg`
    UPDATE catch_all_rereaches SET status = ${status}, decided_at = now()
     WHERE candidate_id = ${candidateId}::uuid AND status = 'offered'
  `;
}
