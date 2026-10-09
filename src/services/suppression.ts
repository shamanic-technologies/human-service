// Per-brand cross-provider suppression (B/S/G).
//
// The people gateway serves leads for a brand via apollo OR apify. Only the
// gateway sees both providers' emissions for a brand, so "already served for
// this brand within the window" is a cross-provider truth that lives here.
//
//   recordServe        — append bronze `lead_serves` + upsert silver
//                        `brand_suppressions`, one per atomic brand.
//   partitionSuppressed — apollo path: split free teasers into fresh / already
//                        served for the brand (match on linkedin_url_norm OR
//                        provider_person_id), BEFORE paying to reveal their email;
//                        the taken half carries the row it matched so the caller
//                        can record that its audience FOUND them (multi-source).
//   filterSuppressed   — the fresh half of partitionSuppressed.
//   getSuppressionSet  — apify path: the exclude-set (emails + linkedin urls)
//                        pushed down so apify never returns/bills a served lead.
//   isEmailSuppressed  — resolve-email block: cap re-emission for the residual
//                        no-linkedin cross-provider edge. Checks EVERY address of
//                        the person (person-emails.ts), like claimServe.
//   claimServe         — the reveal path's ATOMIC check-and-record: claims the
//                        person for every brand, or reports them already served
//                        (two concurrent serves of one person, e.g. under two
//                        audiences of the brand, can never both win).
//
// Identity keys: email_norm is canonical (always present when a verified email
// is served). linkedin_url_norm is the cross-provider key available BEFORE
// paying on both providers (apollo teaser + apify lead both carry it).
//
// Window = 3 months, enforced on read via last_served_at. No silent fallbacks.

import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { brandSuppressions, leadServes } from "../db/schema.js";
import { personAddressSet } from "./person-emails.js";

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
  // "crm" is a valid source for MEMBERSHIP tagging (tagAudienceServe). It never
  // reaches recordServe below — crm-service owns per-brand suppression, so the
  // gateway never writes crm serves into brand_suppressions.
  provider: "apollo" | "apify" | "crm";
  providerPersonId: string | null;
}

// Record a serve: append-only bronze rows + canonical silver upsert, one per
// atomic brand. A multi-brand serve [A,B] suppresses A and B independently
// (per the identity-keying rule: dedup keys on the atomic member).
export async function recordServe(
  orgId: string,
  brandIds: string[],
  contacts: ServedContact[],
  ctx: {
    campaignId?: string;
    runId?: string;
    audienceId?: string;
    // Pre-serve verification verdict, recorded on the bronze row only.
    emailVerdict?: string;
  } = {}
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
        emailVerdict: ctx.emailVerdict ?? null,
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

// The suppression row a dropped teaser matched: the address it was served
// under, plus the pre-pay keys. Enough to tie the teaser to its canonical person
// without paying for anything.
export interface SuppressionMatch {
  emailNorm: string;
  linkedinUrlNorm: string | null;
  providerPersonId: string | null;
}

// apollo path: split teasers into those still free for every requested brand and
// those already served for one of them within the window, matching on the FREE
// pre-pay keys (linkedin_url_norm OR provider_person_id) — so we never pay to
// enrich an already-served lead. The taken ones carry the suppression row they
// matched, so the caller can still record that this source FOUND them.
export async function partitionSuppressed<
  T extends { linkedinUrl: string | null; providerPersonId: string | null }
>(
  orgId: string,
  brandIds: string[],
  items: T[]
): Promise<{ fresh: T[]; taken: Array<{ item: T; match: SuppressionMatch }> }> {
  if (brandIds.length === 0 || items.length === 0) return { fresh: items, taken: [] };

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
  if (linkedinNorms.length === 0 && personIds.length === 0) return { fresh: items, taken: [] };

  const matchConds = [];
  if (linkedinNorms.length > 0)
    matchConds.push(inArray(brandSuppressions.linkedinUrlNorm, linkedinNorms));
  if (personIds.length > 0)
    matchConds.push(inArray(brandSuppressions.providerPersonId, personIds));

  const rows = await db
    .select({
      emailNorm: brandSuppressions.emailNorm,
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

  const byLinkedin = new Map<string, SuppressionMatch>();
  const byPersonId = new Map<string, SuppressionMatch>();
  for (const r of rows) {
    if (r.linkedinUrlNorm !== null) byLinkedin.set(r.linkedinUrlNorm, r);
    if (r.providerPersonId !== null) byPersonId.set(r.providerPersonId, r);
  }

  const fresh: T[] = [];
  const taken: Array<{ item: T; match: SuppressionMatch }> = [];
  for (const i of items) {
    const ln = normalizeLinkedinUrl(i.linkedinUrl);
    const match =
      (ln !== null ? byLinkedin.get(ln) : undefined) ??
      (i.providerPersonId ? byPersonId.get(i.providerPersonId) : undefined);
    if (match) taken.push({ item: i, match });
    else fresh.push(i);
  }
  return { fresh, taken };
}

// apollo path: drop teasers already served for any requested brand within the
// window (the `fresh` half of partitionSuppressed).
export async function filterSuppressed<
  T extends { linkedinUrl: string | null; providerPersonId: string | null }
>(orgId: string, brandIds: string[], items: T[]): Promise<T[]> {
  return (await partitionSuppressed(orgId, brandIds, items)).fresh;
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
  return anyAddressSuppressed(
    orgId,
    brandIds,
    await personAddressSet(db, orgId, [emailNorm])
  );
}

// Is any of these addresses served for any requested brand within the window?
async function anyAddressSuppressed(
  orgId: string,
  brandIds: string[],
  emailNorms: string[]
): Promise<boolean> {
  if (emailNorms.length === 0) return false;
  const rows = await db
    .select({ id: brandSuppressions.id })
    .from(brandSuppressions)
    .where(
      and(
        eq(brandSuppressions.orgId, orgId),
        inArray(brandSuppressions.brandId, brandIds),
        inArray(brandSuppressions.emailNorm, emailNorms),
        gt(brandSuppressions.lastServedAt, windowCutoff())
      )
    )
    .limit(1);
  return rows.length > 0;
}

class AlreadyServedForBrand extends Error {}

/**
 * Claim a revealed person for every brand of the request, atomically: the
 * silver upsert only takes a row that is absent or whose window has lapsed
 * (`WHERE last_served_at <= cutoff`), so of two concurrent serves of the same
 * person for the same brand (two audiences of a portfolio overlap by
 * construction) exactly one gets the row back; the other waits on the row lock,
 * then sees an in-window row and loses. Returns false (nothing written) when the
 * person is already served for any requested brand within the window, true
 * after recording bronze + silver exactly like `recordServe`.
 */
export async function claimServe(
  orgId: string,
  brandIds: string[],
  contact: ServedContact,
  ctx: { campaignId?: string; runId?: string; audienceId?: string; emailVerdict?: string } = {}
): Promise<boolean> {
  if (brandIds.length === 0) return true;
  const emailNorm = normalizeEmail(contact.email);
  if (emailNorm === null) {
    // No address ⟹ nothing to dedup against (same as recordServe).
    await recordServe(orgId, brandIds, [contact], ctx);
    return true;
  }
  // A person holds every address they write from (person-emails.ts): served at
  // ANY of them for the brand means served. The address being claimed is decided
  // atomically below; the person's OTHER addresses are checked here.
  const otherAddresses = (await personAddressSet(db, orgId, [emailNorm])).filter(
    (e) => e !== emailNorm
  );
  if (await anyAddressSuppressed(orgId, brandIds, otherAddresses)) return false;
  const linkedinNorm = normalizeLinkedinUrl(contact.linkedinUrl);
  try {
    await db.transaction(async (tx) => {
      for (const brandId of brandIds) {
        const claimed = await tx
          .insert(brandSuppressions)
          .values({
            orgId,
            brandId,
            emailNorm,
            linkedinUrlNorm: linkedinNorm,
            providerPersonId: contact.providerPersonId,
            lastProvider: contact.provider,
          })
          .onConflictDoUpdate({
            target: [brandSuppressions.orgId, brandSuppressions.brandId, brandSuppressions.emailNorm],
            set: {
              lastServedAt: sql`now()`,
              lastProvider: contact.provider,
              linkedinUrlNorm: sql`coalesce(excluded.linkedin_url_norm, ${brandSuppressions.linkedinUrlNorm})`,
              providerPersonId: sql`coalesce(excluded.provider_person_id, ${brandSuppressions.providerPersonId})`,
            },
            setWhere: sql`${brandSuppressions.lastServedAt} <= ${windowCutoff()}`,
          })
          .returning({ id: brandSuppressions.id });
        if (claimed.length === 0) throw new AlreadyServedForBrand();
        await tx.insert(leadServes).values({
          orgId,
          brandId,
          provider: contact.provider,
          providerPersonId: contact.providerPersonId,
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          linkedinUrl: contact.linkedinUrl,
          companyDomain: contact.companyDomain,
          campaignId: ctx.campaignId ?? null,
          runId: ctx.runId ?? null,
          audienceId: ctx.audienceId ?? null,
          emailVerdict: ctx.emailVerdict ?? null,
        });
      }
    });
    return true;
  } catch (err) {
    if (err instanceof AlreadyServedForBrand) return false;
    throw err;
  }
}
