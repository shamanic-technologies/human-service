// Per-brand cross-provider suppression (B/S/G).
//
// The people gateway serves leads for a brand via apollo OR apify. Only the
// gateway sees both providers' emissions for a brand, so "already served for
// this brand within the window" is a cross-provider truth that lives here.
//
//   recordServe        — append bronze `lead_serves` + upsert silver
//                        `brand_suppressions`, one per atomic brand.
//   filterSuppressed   — apollo path: drop free teasers already served for the
//                        brand (match on linkedin_url_norm OR provider_person_id),
//                        BEFORE paying to reveal their email.
//   getSuppressionSet  — apify path: the exclude-set (emails + linkedin urls)
//                        pushed down so apify never returns/bills a served lead.
//   isEmailSuppressed  — resolve-email block: cap re-emission for the residual
//                        no-linkedin cross-provider edge.
//
// Identity keys: email_norm is canonical (always present when a verified email
// is served). linkedin_url_norm is the cross-provider key available BEFORE
// paying on both providers (apollo teaser + apify lead both carry it).
//
// Window = 3 months, enforced on read via last_served_at. No silent fallbacks.

import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandSuppressions, leadServes } from "../db/schema.js";

// Calendar-accurate 3-month window, evaluated by Postgres at query time. The
// single source of the re-contact window — every read path (teaser filter,
// exclude-set, resolve-email block, AND the audiences contactability rollup)
// references this so "suppressed within window" never diverges.
export const windowCutoff = () => sql`now() - interval '3 months'`;

export function normalizeEmail(
  email: string | null | undefined
): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  return e.length > 0 ? e : null;
}

export function normalizeLinkedinUrl(
  url: string | null | undefined
): string | null {
  if (!url) return null;
  let u = url.trim().toLowerCase();
  if (u.length === 0) return null;
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  u = u.split(/[?#]/)[0]; // drop query string / fragment
  u = u.replace(/\/+$/, ""); // drop trailing slash(es)
  return u.length > 0 ? u : null;
}

export interface ServedContact {
  email: string | null;
  linkedinUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  companyDomain: string | null;
  provider: "apollo" | "apify";
  providerPersonId: string | null;
}

// Record a serve: append-only bronze rows + canonical silver upsert, one per
// atomic brand. A multi-brand serve [A,B] suppresses A and B independently
// (per the identity-keying rule: dedup keys on the atomic member).
export async function recordServe(
  orgId: string,
  brandIds: string[],
  contacts: ServedContact[],
  ctx: { campaignId?: string; runId?: string; audienceId?: string } = {}
): Promise<void> {
  if (brandIds.length === 0 || contacts.length === 0) return;

  for (const brandId of brandIds) {
    for (const c of contacts) {
      const emailNorm = normalizeEmail(c.email);
      const linkedinNorm = normalizeLinkedinUrl(c.linkedinUrl);

      // 🥉 Bronze — append-only, source-faithful (recorded even when the email
      // is absent, for audit / silver-rebuild).
      await db.insert(leadServes).values({
        orgId,
        brandId,
        provider: c.provider,
        providerPersonId: c.providerPersonId,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        linkedinUrl: c.linkedinUrl,
        companyDomain: c.companyDomain,
        campaignId: ctx.campaignId ?? null,
        runId: ctx.runId ?? null,
        audienceId: ctx.audienceId ?? null,
      });

      // 🥈 Silver — canonical row keyed on email_norm (the only stable
      // cross-provider identity). No email ⟹ nothing to dedup against later.
      if (!emailNorm) continue;
      await db
        .insert(brandSuppressions)
        .values({
          orgId,
          brandId,
          emailNorm,
          linkedinUrlNorm: linkedinNorm,
          providerPersonId: c.providerPersonId,
          lastProvider: c.provider,
        })
        .onConflictDoUpdate({
          target: [
            brandSuppressions.orgId,
            brandSuppressions.brandId,
            brandSuppressions.emailNorm,
          ],
          set: {
            lastServedAt: sql`now()`,
            lastProvider: c.provider,
            // Backfill the cross-provider match columns if a later serve learns
            // them (prefer the new value, keep the old when the new is null).
            linkedinUrlNorm: sql`coalesce(excluded.linkedin_url_norm, ${brandSuppressions.linkedinUrlNorm})`,
            providerPersonId: sql`coalesce(excluded.provider_person_id, ${brandSuppressions.providerPersonId})`,
          },
        });
    }
  }
}

// apollo path: drop teasers already served for any requested brand within the
// window, matching on the FREE pre-pay keys (linkedin_url_norm OR
// provider_person_id) — so we never pay to enrich an already-served lead.
export async function filterSuppressed<
  T extends { linkedinUrl: string | null; providerPersonId: string | null }
>(orgId: string, brandIds: string[], items: T[]): Promise<T[]> {
  if (brandIds.length === 0 || items.length === 0) return items;

  const linkedinNorms = [
    ...new Set(
      items
        .map((i) => normalizeLinkedinUrl(i.linkedinUrl))
        .filter((x): x is string => x !== null)
    ),
  ];
  const personIds = [
    ...new Set(
      items
        .map((i) => i.providerPersonId)
        .filter((x): x is string => x !== null && x.length > 0)
    ),
  ];
  if (linkedinNorms.length === 0 && personIds.length === 0) return items;

  const matchConds = [];
  if (linkedinNorms.length > 0)
    matchConds.push(inArray(brandSuppressions.linkedinUrlNorm, linkedinNorms));
  if (personIds.length > 0)
    matchConds.push(inArray(brandSuppressions.providerPersonId, personIds));

  const rows = await db
    .select({
      linkedinUrlNorm: brandSuppressions.linkedinUrlNorm,
      providerPersonId: brandSuppressions.providerPersonId,
    })
    .from(brandSuppressions)
    .where(
      and(
        eq(brandSuppressions.orgId, orgId),
        inArray(brandSuppressions.brandId, brandIds),
        gt(brandSuppressions.lastServedAt, windowCutoff()),
        or(...matchConds)
      )
    );

  const suppressedLinkedins = new Set(
    rows.map((r) => r.linkedinUrlNorm).filter((x): x is string => x !== null)
  );
  const suppressedPersonIds = new Set(
    rows.map((r) => r.providerPersonId).filter((x): x is string => x !== null)
  );

  return items.filter((i) => {
    const ln = normalizeLinkedinUrl(i.linkedinUrl);
    if (ln !== null && suppressedLinkedins.has(ln)) return false;
    if (i.providerPersonId && suppressedPersonIds.has(i.providerPersonId))
      return false;
    return true;
  });
}

// apify path: the windowed exclude-set pushed down to apify /search so the paid
// actor never returns (never bills) a lead already served for the brand.
export async function getSuppressionSet(
  orgId: string,
  brandIds: string[]
): Promise<{ emails: string[]; linkedinUrls: string[] }> {
  if (brandIds.length === 0) return { emails: [], linkedinUrls: [] };

  const rows = await db
    .select({
      emailNorm: brandSuppressions.emailNorm,
      linkedinUrlNorm: brandSuppressions.linkedinUrlNorm,
    })
    .from(brandSuppressions)
    .where(
      and(
        eq(brandSuppressions.orgId, orgId),
        inArray(brandSuppressions.brandId, brandIds),
        gt(brandSuppressions.lastServedAt, windowCutoff())
      )
    );

  const emails = [
    ...new Set(rows.map((r) => r.emailNorm).filter((x): x is string => x !== null)),
  ];
  const linkedinUrls = [
    ...new Set(
      rows.map((r) => r.linkedinUrlNorm).filter((x): x is string => x !== null)
    ),
  ];
  return { emails, linkedinUrls };
}

// resolve-email block: catch the residual edge where an apify-served lead with
// no linkedin slipped through the apollo teaser filter and got enriched — the
// credit is spent, but we still must not re-serve. Returns true ⟹ suppressed.
export async function isEmailSuppressed(
  orgId: string,
  brandIds: string[],
  email: string | null
): Promise<boolean> {
  const emailNorm = normalizeEmail(email);
  if (brandIds.length === 0 || emailNorm === null) return false;

  const rows = await db
    .select({ id: brandSuppressions.id })
    .from(brandSuppressions)
    .where(
      and(
        eq(brandSuppressions.orgId, orgId),
        inArray(brandSuppressions.brandId, brandIds),
        eq(brandSuppressions.emailNorm, emailNorm),
        gt(brandSuppressions.lastServedAt, windowCutoff())
      )
    )
    .limit(1);

  return rows.length > 0;
}
