// GOOGLE MAPS — the email a local business PUBLISHES on its own website
// (GMAPS-EMAIL-1117).
//
// A Google Maps business carries a phone and often a website, never an email.
// To write to it by email, we read its site the way a person would: the
// homepage, then the pages it links to that usually carry the contact (Impressum,
// Kontakt, Contact, Imprint, Legal, About...). Every page goes through treg's
// routed web extract, cheapest provider first (free public route first),
// METERED like the Maps search (src/lib/treg-meter.ts).
//
// From what the pages say:
//   - every address PUBLISHED on them (text or mailto:) is collected; nothing is
//     ever guessed (no "info@<domain>" invented);
//   - ONE chat-service call (cheap model) picks the address that belongs to the
//     business (a web agency's or a platform's address is not the shop's) and the
//     person the site names as responsible / owner, if any. Both answers are
//     checked against what was read: the email must be one of the published
//     addresses, the name must appear verbatim in the pages. Anything else is
//     dropped, so a name is never invented.
//
// Stored once per Google place id, fleet-wide (google_maps_site_reads, bronze):
// a business's site is never read twice. Whether the address is deliverable is
// asked separately, per serve (apollo-service verification, 30-day reuse there).

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { googleMapsSiteReads } from "../db/schema.js";
import { completeJson } from "../lib/chat-client.js";
import { TregMeter } from "../lib/treg-meter.js";
import { registrableDomain } from "./own-company.js";
import { businessDomain } from "./google-maps-source.js";
import type { Identity } from "./people-providers.js";

/** treg's routed page extract (free public route first, a miss tries the next). */
export const SITE_EXTRACT_ENDPOINT = "treg.web.extract";
/** The most one page may cost: $0.001 (free / crawl4ai $0.00025 answer first). */
export const SITE_PAGE_MAX_MICRO = 1_000;
/** Pages linked from the homepage read at most, beside the homepage. */
export const SITE_MAX_CONTACT_PAGES = 3;
/** Page text kept in bronze, and shown to the picker, per page. */
const PAGE_TEXT_KEPT = 20_000;
const PAGE_TEXT_SHOWN = 6_000;

// The words a contact page's address carries, in the languages businesses write
// their sites in. A link qualifies when its PATH holds one of them.
const CONTACT_PATH = /(impressum|imprint|kontakt|contact|contacto|contato|contatti|kontakty|kapcsolat|legal|mentions|aviso-legal|note-legali|about|ueber-uns|uber-uns|über-uns|a-propos|chi-siamo|sobre|team)/i;
const CONTACT_PRIORITY = [/impressum|imprint|mentions|aviso-legal|note-legali|legal/i, /kontakt|contact|contacto|contato|contatti|kontakty|kapcsolat/i];

const EMAIL_RE = /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;
const NOT_AN_ADDRESS = /\.(png|jpe?g|gif|webp|svg|avif|css|js)$/i;

export interface SitePage {
  url: string;
  finalUrl: string | null;
  status: number;
  servedBy: string | null;
  chargedMicro: number;
  text: string | null;
  links: string[];
}

export type SiteOutcome = "found" | "no_website" | "no_email";

export interface SiteContact {
  outcome: SiteOutcome;
  email: string | null;
  contactName: string | null;
  contactRole: string | null;
  emails: string[];
}

/** "https://shop.ch/menu?x" ⟹ "https://shop.ch/" (the homepage of the site). */
export function homepageOf(website: string | null | undefined): string | null {
  if (!website || !website.trim()) return null;
  const raw = /^[a-z]+:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}/`;
  } catch {
    return null;
  }
}

/** The pages of the SAME site the homepage links to that usually carry a contact, legal pages first. */
export function contactPageLinks(homepage: string, links: readonly string[], max = SITE_MAX_CONTACT_PAGES): string[] {
  const site = registrableDomain(homepage);
  const seen = new Set<string>([normalizeUrl(homepage)]);
  const picked: string[] = [];
  for (const link of links) {
    let u: URL;
    try {
      u = new URL(link, homepage);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (registrableDomain(u.href) !== site) continue;
    const path = decodeURIComponent(u.pathname);
    if (!CONTACT_PATH.test(path)) continue;
    const key = normalizeUrl(u.href);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(`${u.protocol}//${u.host}${u.pathname}`);
  }
  const rank = (url: string) => {
    const i = CONTACT_PRIORITY.findIndex((re) => re.test(new URL(url).pathname));
    return i === -1 ? CONTACT_PRIORITY.length : i;
  };
  return picked
    .map((url, i) => ({ url, i }))
    .sort((a, b) => rank(a.url) - rank(b.url) || a.i - b.i)
    .slice(0, max)
    .map((x) => x.url);
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Every address the pages PUBLISH: in their text (including the common
 * "info(at)shop.ch" / "info [at] shop [dot] ch" spellings) and in mailto: links.
 * Lowercased, de-duplicated, in the order they appear. Never constructed.
 */
export function publishedEmails(pages: ReadonlyArray<Pick<SitePage, "text" | "links">>): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const e = raw.trim().replace(/^mailto:/i, "").split("?")[0].replace(/[.,;:]+$/, "").toLowerCase();
    if (!e.includes("@") || NOT_AN_ADDRESS.test(e)) return;
    const m = e.match(EMAIL_RE);
    if (!m || m[0] !== e) return;
    if (!out.includes(e)) out.push(e);
  };
  for (const p of pages) {
    const text = (p.text ?? "")
      .replace(/\s*[([{]\s*at\s*[)\]}]\s*/gi, "@")
      .replace(/\s*[([{]\s*(dot|punkt|point)\s*[)\]}]\s*/gi, ".");
    for (const m of text.match(EMAIL_RE) ?? []) add(m);
    for (const l of p.links) if (/^mailto:/i.test(l)) add(decodeURIComponent(l));
  }
  return out;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// ─── Reading the site ──────────────────────────────────────────────────────────

async function readPage(meter: TregMeter, url: string): Promise<SitePage> {
  const answer = await meter.call(SITE_EXTRACT_ENDPOINT, { method: "POST", body: { url }, maxMicro: SITE_PAGE_MAX_MICRO });
  const page = (answer.body?.output as { pages?: Array<Record<string, unknown>> } | undefined)?.pages?.[0];
  const ok = answer.status >= 200 && answer.status < 300 && !!page;
  return {
    url,
    finalUrl: ok && typeof page!.final_url === "string" ? (page!.final_url as string) : null,
    status: answer.status,
    servedBy: answer.servedBy,
    chargedMicro: answer.chargedMicro,
    text: ok && typeof page!.text === "string" ? (page!.text as string).slice(0, PAGE_TEXT_KEPT) : null,
    links: ok && Array.isArray(page!.links) ? (page!.links as unknown[]).filter((l): l is string => typeof l === "string") : [],
  };
}

const PICK_SYSTEM_PROMPT = [
  "You read the pages of a local business's own website and say how to write to that business by email.",
  "EMAIL: pick, from the ADDRESSES list only, the one address that belongs to this business (a generic one like info@ or a shop mailbox is right).",
  "Never pick the address of someone else: the web agency or developer who built the site, a hosting or booking platform, a supplier, an example.",
  "If no address in the list belongs to the business, answer null.",
  "NAME: the person the pages name as the owner, manager or person responsible for the business (for example after 'Inhaber', 'Geschäftsführer', 'Verantwortlich', 'Owner', 'Gérant', 'Titolare'), copied exactly as written on the page.",
  "Never the web designer, never a photographer credit, never a name you infer from the address. If the pages name nobody, answer null.",
  "ROLE: the word the page uses for that person's role, copied exactly as written (null if none).",
  'Answer JSON only: {"email": string|null, "name": string|null, "role": string|null}.',
].join("\n");

async function pickContact(
  business: { name: string | null; website: string },
  pages: SitePage[],
  emails: string[],
  identity: Identity
): Promise<{ email: string | null; contactName: string | null; contactRole: string | null }> {
  const shown = pages
    .filter((p) => p.text)
    .map((p) => `--- PAGE ${p.finalUrl ?? p.url}\n${p.text!.slice(0, PAGE_TEXT_SHOWN)}`)
    .join("\n\n");
  const out = await completeJson({
    message: `BUSINESS: ${business.name ?? "(unnamed)"} (${business.website})\n\nADDRESSES:\n${emails.join("\n")}\n\n${shown}`,
    systemPrompt: PICK_SYSTEM_PROMPT,
    identity,
    provider: "google",
    model: "flash-pro",
    disableThinking: true,
  });
  const all = collapse(pages.map((p) => p.text ?? "").join("\n"));
  const email = typeof out.email === "string" && emails.includes(out.email.trim().toLowerCase()) ? out.email.trim().toLowerCase() : null;
  // Only what the pages say verbatim: a name or role the picker wrote itself is dropped.
  const verbatim = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.replace(/\s+/g, " ").trim();
    return t.length >= 2 && t.length <= 120 && all.includes(collapse(t)) ? t : null;
  };
  const contactName = verbatim(out.name);
  return { email, contactName, contactRole: contactName ? verbatim(out.role) : null };
}

export interface SiteReadContext {
  placeId: string;
  businessName: string | null;
  website: string | null;
  identity: Identity;
  /** The metered treg client of this serve (its child run carries the spend). */
  meter: () => TregMeter;
}

/**
 * The contact a business publishes on its site: the stored read when there is
 * one (never read twice), else read now, store, answer.
 */
export async function siteContactOf(ctx: SiteReadContext): Promise<SiteContact> {
  const [stored] = await db.select().from(googleMapsSiteReads).where(eq(googleMapsSiteReads.placeId, ctx.placeId)).limit(1);
  if (stored) {
    return {
      outcome: stored.outcome as SiteOutcome,
      email: stored.email,
      contactName: stored.contactName,
      contactRole: stored.contactRole,
      emails: stored.emails,
    };
  }

  const homepage = businessDomain(ctx.website) ? homepageOf(ctx.website) : null;
  let result: SiteContact;
  let pages: SitePage[] = [];
  let runId: string | null = null;
  if (!homepage) {
    result = { outcome: "no_website", email: null, contactName: null, contactRole: null, emails: [] };
  } else {
    const meter = ctx.meter();
    const home = await readPage(meter, homepage);
    pages = [home];
    for (const url of contactPageLinks(home.finalUrl ?? homepage, home.links)) pages.push(await readPage(meter, url));
    runId = await meter.openedRunId();
    const emails = publishedEmails(pages);
    if (emails.length === 0) {
      result = { outcome: "no_email", email: null, contactName: null, contactRole: null, emails };
    } else {
      if (!runId || !ctx.identity.userId) throw new Error("google_maps site read: no run opened for the contact pick");
      const pick = await pickContact({ name: ctx.businessName, website: homepage }, pages, emails, { ...ctx.identity, runId });
      result = { outcome: pick.email ? "found" : "no_email", email: pick.email, contactName: pick.contactName, contactRole: pick.contactRole, emails };
    }
  }

  const charged = pages.reduce((n, p) => n + p.chargedMicro, 0);
  await db
    .insert(googleMapsSiteReads)
    .values({
      placeId: ctx.placeId,
      website: ctx.website,
      orgId: ctx.identity.orgId,
      runId,
      outcome: result.outcome,
      pages: pages.map((p) => ({ ...p })),
      emails: result.emails,
      email: result.email,
      contactName: result.contactName,
      contactRole: result.contactRole,
      chargedMicro: charged,
    })
    .onConflictDoNothing();
  console.log(
    `[human-service] google_maps.site_read org=${ctx.identity.orgId} place=${ctx.placeId} outcome=${result.outcome} pages=${pages.length} emails=${result.emails.length} named=${result.contactName ? "yes" : "no"} charged_micro=${charged} run=${runId ?? "-"}`
  );
  return result;
}
