// Re-contact of people this audience already served, once the serve's window
// says they may be written to again (FRESH-2-MONTHS-1027).
//
// WHY. The apollo walk is forward-only: a teaser already buffered, offered or
// revealed under an audience is never handed back by the provider cursor. So a
// serve stating a SHORTER window (`excludeEmailedWithin: "2_months"`) would only
// lift the suppression for people some OTHER audience happens to re-find: a used
// up market (Doc Dinners, 47.7k held, ~3,800 emailed 60-90 days ago) would get
// nobody back. This walks the brand's suppression rows lapsed under the serve's
// window, keyed on the audience that served them (its filters and its screen
// put them there), and hands them to the serve's usual pipeline.
//
// NO SECOND REVEAL CHARGE. The re-reach goes through the same `resolveEmail` a
// fresh teaser does, so every post-reveal gate (opt-out, won / never-cold-
// contact, own company, bounce, verdict policy) and the atomic `claimServe`
// (under the serve's window: the window restarts from this serve, a new bronze
// row is written) apply unchanged. apollo-service answers an enrich of a person
// it already revealed from its 12-month person cache: no Apollo call, no
// credit. Only the address's verification is re-run when its verdict is older
// than apollo-service's 30-day reuse, which is the check we want before writing
// to someone again after 2 months.
//
// THE POPULATION (`selectLapsed`, one keyset page): a `brand_suppressions` row of
// the brand anchored (last serve or last real email) at or before the serve's
// cutoff, whose apollo person was served under THIS audience (and this source of
// it), who was actually handed or emailed (a `served` audience membership of the
// address under the brand, or a recorded send), not rejected for the audience
// (`audience_screened_out`, a decline included), and with no open candidate in it.
// Oldest anchor first. Absent / `3_months` = never called: today's serve.

import { sql as pg } from "../db/index.js";
import type { TeaserSnapshot } from "../db/schema.js";
import type { BufferedTeaser } from "./teaser-buffer.js";
import type { Identity } from "./people-providers.js";
import { partitionSuppressed } from "./suppression.js";
import { matchesOptOut, type OptOutExclusions } from "./opt-outs.js";
import { isOwnCompany, type OwnCompany } from "./own-company.js";
import { filterBounced } from "./bounces.js";
import { WINDOW_INTERVAL, type ExcludeEmailedWithin } from "../lib/recontact-window.js";

export interface LapsedServe extends BufferedTeaser {
  emailNorm: string;
  // The suppression anchor, as Postgres prints it (keyset position, verbatim).
  anchor: string;
  // The audience's candidate row for this person (a decided `revealed` one), if any.
  candidateId: string | null;
}

export interface LapsedCursor {
  anchor: string;
  emailNorm: string;
}

interface LapsedRow {
  email_norm: string;
  anchor: string;
  provider_person_id: string;
  linkedin_url: string | null;
  company_domain: string | null;
  candidate_id: string | null;
  teaser_domain: string | null;
  teaser: TeaserSnapshot | null;
}

export const LAPSED_PAGE = 50;

/** The next page of people this audience served whose brand window has lapsed. Free, claims nothing. */
export async function selectLapsed(
  orgId: string,
  brandId: string,
  audienceId: string,
  sourceId: string | null,
  window: ExcludeEmailedWithin,
  after: LapsedCursor | null,
  limit: number = LAPSED_PAGE
): Promise<LapsedServe[]> {
  const interval = WINDOW_INTERVAL[window];
  const afterClause = after
    ? pg`AND (bs.last_served_at, bs.email_norm) > (${after.anchor}::timestamptz, ${after.emailNorm})`
    : pg``;
  const rows = await pg<LapsedRow[]>`
    SELECT bs.email_norm, bs.last_served_at::text AS anchor,
           ls.provider_person_id, ls.linkedin_url, ls.company_domain,
           ac.id AS candidate_id, ac.organization_domain AS teaser_domain,
           COALESCE(ac.teaser, (
             SELECT s.teaser FROM audience_teaser_screenings s
              WHERE s.audience_id = ${audienceId}::uuid AND s.provider_person_id = ls.provider_person_id
              ORDER BY s.created_at DESC LIMIT 1
           )) AS teaser
      FROM brand_suppressions bs
      JOIN LATERAL (
        SELECT l.provider_person_id, l.linkedin_url, l.company_domain
          FROM lead_serves l
         WHERE l.provider_person_id = bs.provider_person_id
           AND l.org_id = bs.org_id AND l.brand_id = bs.brand_id
           AND l.audience_id = ${audienceId}::uuid AND l.provider = 'apollo'
           AND l.audience_source_id IS NOT DISTINCT FROM ${sourceId}::uuid
           AND lower(btrim(l.email)) = bs.email_norm
         ORDER BY l.served_at DESC
         LIMIT 1
      ) ls ON true
      LEFT JOIN audience_candidates ac
        ON ac.audience_id = ${audienceId}::uuid AND ac.provider_person_id = ls.provider_person_id
     WHERE bs.org_id = ${orgId}::uuid AND bs.brand_id = ${brandId}::uuid
       AND bs.provider_person_id IS NOT NULL
       AND bs.last_served_at <= now() - ${interval}::interval
       ${afterClause}
       AND (ac.id IS NULL OR ac.status = 'revealed')
       AND NOT EXISTS (
         SELECT 1 FROM audience_screened_out so
          WHERE so.audience_id = ${audienceId}::uuid AND so.provider_person_id = ls.provider_person_id)
       AND (bs.last_sent_at IS NOT NULL OR EXISTS (
         SELECT 1 FROM audience_members m
           JOIN audiences a ON a.id = m.audience_id AND a.brand_id = bs.brand_id
          WHERE m.org_id = bs.org_id AND m.provenance = 'served'
            AND m.person_id IN (
              SELECT p.id FROM people p WHERE p.org_id = bs.org_id AND p.email_norm = bs.email_norm
              UNION
              SELECT pe.person_id FROM person_emails pe
               WHERE pe.org_id = bs.org_id AND pe.email_norm = bs.email_norm)))
     ORDER BY bs.last_served_at ASC, bs.email_norm ASC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    emailNorm: r.email_norm,
    anchor: r.anchor,
    providerPersonId: r.provider_person_id,
    linkedinUrl: r.linkedin_url,
    teaser: r.teaser,
    organizationDomain: r.teaser_domain ?? r.company_domain,
    candidateId: r.candidate_id,
  }));
}

/**
 * The free gates a popped teaser passes, run on a whole page at once (one read
 * per gate, not one per person: a person a gate holds forever, a won or bounced
 * one, is read again on every walk): another address of the person still inside
 * the serve's window, standing opt-out / won, the brand's own company, a hard
 * bounce. Returns the survivors in page order. Their provenance was recorded when
 * they were first served, so nothing is tagged here.
 */
export async function passLapsedFreeGates(
  identity: Identity,
  brandId: string,
  page: LapsedServe[],
  exclusions: OptOutExclusions,
  ownCompany: OwnCompany
): Promise<LapsedServe[]> {
  const window = identity.excludeEmailedWithin;
  const { fresh } = await partitionSuppressed(identity.orgId, [brandId], page, window);
  const open = fresh.filter(
    (l) =>
      !matchesOptOut(exclusions, { linkedinUrl: l.linkedinUrl, providerPersonId: l.providerPersonId }) &&
      !isOwnCompany(ownCompany, { name: l.teaser?.organizationName ?? null })
  );
  return filterBounced(identity, open);
}
