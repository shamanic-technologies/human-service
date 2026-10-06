// A brand never prospects its own company.
//
// When an audience's target resembles the brand itself (research labs selling to
// research labs, agencies to agencies, SaaS to SaaS), the provider happily
// returns the brand's own staff: the onboarding preview for home.cern listed
// "Director of Research and Computing · CERN (home.cern)" as a company to write
// to. Owner rule (2026-10-06): « we should not send to people at the company
// itself ». The producer of prospects owns that rule, so it lives here, on every
// path that picks people or companies for a brand.
//
// WHICH company the brand is comes from brand-service (src/lib/brand-identity.ts):
//   - its website domain, compared on the REGISTRABLE domain (tldts, private
//     suffixes on), so subdomains match both ways: brand `home.web.cern.ch`
//     excludes `cern.ch`, a person at `it.home.cern` is excluded for `home.cern`;
//   - the domain of the brand's sales-rep email, when it is a work address (the
//     sibling domain a website domain cannot reveal), never a free-mail domain;
//   - its display name, matched EXACTLY after normalization, for the one stage
//     where no domain exists: apollo's free teaser carries the employer's name
//     only, and that is the last moment a person can be dropped for free.
// A shared hosting platform (facebook.com, linktr.ee, ...) is not a company the
// brand belongs to, so it is never used as an own-company domain.
//
// Read once per (org, brand) and kept 10 minutes in process: a brand's domain
// does not move, and the serve path checks every teaser. Fail loud: a brand
// brand-service cannot answer for throws (502 at the route), never a serve that
// skips the rule.

import { getDomain } from "tldts";
import { getBrandIdentity, type BrandIdentity } from "../lib/brand-identity.js";
import type { Person } from "./people-providers.js";

export interface OwnCompany {
  // Registrable domains of the brand's company.
  domains: Set<string>;
  // Normalized display names of the brand's company.
  names: Set<string>;
}

export const NO_OWN_COMPANY: OwnCompany = { domains: new Set(), names: new Set() };

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.fr",
  "live.com", "msn.com", "yahoo.com", "yahoo.fr", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de",
  "gmx.net", "web.de", "orange.fr", "free.fr", "laposte.net", "yandex.com",
  "yandex.ru", "mail.ru", "zoho.com", "hey.com", "fastmail.com", "qq.com",
  "163.com",
]);

const HOSTING_PLATFORMS = new Set([
  "facebook.com", "instagram.com", "linkedin.com", "linktr.ee", "google.com",
  "youtube.com", "x.com", "twitter.com", "tiktok.com", "medium.com",
  "substack.com", "wix.com", "squarespace.com", "notion.site", "notion.so",
  "carrd.co", "calendly.com", "etsy.com", "amazon.com",
]);

// A domain, URL, host or email address → its registrable domain, lowercased.
export function registrableDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  const at = v.lastIndexOf("@");
  if (at >= 0) v = v.slice(at + 1);
  return getDomain(v, { allowPrivateDomains: true }) ?? null;
}

export function normalizeCompanyName(value: string | null | undefined): string | null {
  if (!value) return null;
  const n = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  return n.length >= 3 ? n : null;
}

export function ownCompanyOf(brand: Pick<BrandIdentity, "domain" | "url" | "name" | "salesRepEmail">): OwnCompany {
  const domains = new Set<string>();
  const names = new Set<string>();
  for (const candidate of [brand.domain, brand.url]) {
    const d = registrableDomain(candidate);
    if (d && !HOSTING_PLATFORMS.has(d)) domains.add(d);
  }
  const repDomain = registrableDomain(brand.salesRepEmail ?? null);
  if (repDomain && !FREE_MAIL_DOMAINS.has(repDomain) && !HOSTING_PLATFORMS.has(repDomain)) {
    domains.add(repDomain);
  }
  // A lazy-filled name that is really a URL names no company.
  if (!/https?:|www\./i.test(brand.name)) {
    const n = normalizeCompanyName(brand.name);
    if (n) names.add(n);
  }
  return { domains, names };
}

export interface CompanyFacts {
  name?: string | null;
  domain?: string | null;
  website?: string | null;
  email?: string | null;
}

export function isOwnCompany(own: OwnCompany, facts: CompanyFacts): boolean {
  if (own.domains.size === 0 && own.names.size === 0) return false;
  for (const v of [facts.domain, facts.website, facts.email]) {
    const d = registrableDomain(v);
    if (d && own.domains.has(d)) return true;
  }
  const n = normalizeCompanyName(facts.name);
  return n !== null && own.names.has(n);
}

export function isOwnCompanyPerson(own: OwnCompany, person: Person): boolean {
  return isOwnCompany(own, {
    name: person.organization?.name ?? null,
    domain: person.organization?.domain ?? null,
    website: person.organization?.websiteUrl ?? null,
    email: person.email,
  });
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<OwnCompany> }>();

async function loadOne(orgId: string, brandId: string): Promise<OwnCompany> {
  const key = `${orgId}:${brandId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = getBrandIdentity(brandId, orgId).then(ownCompanyOf);
  cache.set(key, { at: Date.now(), value });
  // A failed read is never cached: the next serve asks again.
  value.catch(() => cache.delete(key));
  return value;
}

// The union over every brand of the request: a serve under brands [A, B] must
// not reach A's staff nor B's.
export async function loadOwnCompany(orgId: string, brandIds: string[]): Promise<OwnCompany> {
  if (brandIds.length === 0) return NO_OWN_COMPANY;
  const all = await Promise.all([...new Set(brandIds)].map((b) => loadOne(orgId, b)));
  return {
    domains: new Set(all.flatMap((o) => [...o.domains])),
    names: new Set(all.flatMap((o) => [...o.names])),
  };
}

export function clearOwnCompanyCache(): void {
  cache.clear();
}
