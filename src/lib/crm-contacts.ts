// Client for crm-service — a client's OWN uploaded B2C contact list, a lead
// provider sibling of apollo-service / apify-service. Unlike those, crm-service
// serves contacts by BRAND (no filter vocabulary) and OWNS its own no-re-serve:
// POST /orgs/contacts/serve-next atomically marks the returned contacts served
// and never hands them back again (per-(brand, contact), permanent). So this
// client just asks for the next contact(s) and trusts the `exhausted` signal —
// human-service performs NO local suppression for crm (that is crm-service's job).
//
// Reuses the people-gateway's single outbound HTTP layer (downstreamHeaders +
// fetchWithConnectRetry — cold-start connect-phase retry for a Neon-backed
// sibling) and its fail-loud errors: a non-2xx / network error throws
// ProviderError ("crm") → 502 at the route; a missing env throws
// ProviderConfigError ("crm").

import { errorString } from "./db-error.js";
import {
  downstreamHeaders,
  fetchWithConnectRetry,
  ProviderConfigError,
  ProviderError,
  type Identity,
  type Person,
} from "../services/people-providers.js";
import type { Reach } from "./reach.js";
import type { RelationshipPolicy } from "./relationship-policy.js";
import type { StepFilter } from "./step-filter.js";

function requireCrm(): { url: string; key: string } {
  // Read at call time (not boot) so a missing var fails the request loudly
  // rather than crash-looping boot — same convention as apollo/apify.
  const url = process.env.CRM_SERVICE_URL;
  const key = process.env.CRM_SERVICE_API_KEY;
  if (!url || !key) throw new ProviderConfigError("crm");
  return { url, key };
}

// A served contact as returned by crm-service (deployed shape — see the crm
// api-registry contract). Only the fields human-service maps to a neutral Person
// are declared; the rest of the row is ignored.
export interface CrmContact {
  id: string;
  primaryEmail: string | null;
  phoneE164: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  // What finds the email of a contact the client added without one
  // (crm-service CRM-ADD-ONE-CONTACT-1021, additive: older rows omit them).
  companyName?: string | null;
  companyDomain?: string | null;
  jobTitle?: string | null;
  linkedinUrl?: string | null;
  note?: string | null;
  // known = primaryEmail is the address; unknown = handed out for its email to be
  // looked up (only with `includeEmailUnknown`).
  emailStatus?: "known" | "unknown" | "not_found" | null;
  // A hand-out to ONE asker (crm-service v0.121.0, AUDIENCE-PER-OFFER-1107): the
  // contact is not burned for the brand until that hand-out is served. Absent on a
  // serve-next contact.
  handOutId?: string;
}

// The PEOPLE pool of crm-service (contract live since crm-service v0.39.0): the
// brand's merged persons (every tool the brand connected, one row per human),
// filtered by WHO they are, in the same words for every brand and channel.
// `signedUp` = holds a signup on the brand's auth provider; `replied` = ever wrote
// to the brand on any conversation channel; `reachableBy` = holds a phone / an
// email. Exclusive with the per-file `uploadIds` restriction.
export interface CrmPeopleFilter {
  signedUp?: boolean;
  replied?: boolean;
  reachableBy?: "phone" | "email";
  // A SEGMENT of the brand's own CRM (crm-service `PeopleSegment`: dealStages,
  // dealStatuses, tags, reached / notReached, includeClients, includeOptedOut).
  // crm-service owns the vocabulary and validates it (400 on a bad one); it rides
  // here verbatim, never re-modelled. Absent ⟹ no key on the wire.
  segment?: CrmPeopleSegment;
}

export type CrmPeopleSegment = Record<string, unknown>;

// crm-service's per-stage counts of a segment naming dealStages (serve-stats
// `byStage`). Entries overlap when a person holds deals at two stages.
export interface CrmStageStats {
  pipeline: string | null;
  stage: string;
  served: number;
  remainingSendable: number;
  totalSendable: number;
}

// WHICH pool a CRM serve draws from. `uploadId` = one imported file; `people` = the
// brand's merged people under a filter; neither = the brand's whole imported list.
export interface CrmServeScope {
  uploadId?: string | null;
  people?: CrmPeopleFilter | null;
  // The channel(s) the SERVING PIPE writes on (src/lib/reach.ts), sent top-level as
  // crm-service's `reachableBy` (both pools): a person without them is skipped and NOT
  // marked served, so the pipe that can reach them still gets them. Empty / absent =
  // no key on the wire (bytes unchanged).
  reachableBy?: readonly Reach[] | null;
  // The serving pipe's relationship policy (src/lib/relationship-policy.ts), sent
  // top-level as crm-service's `relationships` (both pools): crm-service skips the
  // people it refuses and does NOT mark them served. Absent = no key on the wire.
  relationships?: RelationshipPolicy | null;
  // The serving pipe's CRM step filter (src/lib/step-filter.ts), sent VERBATIM
  // top-level as crm-service's `stepFilter` (both pools), ANDed there with the pool
  // filter. Absent = no key on the wire.
  stepFilter?: StepFilter | null;
  // CSV pool only: after the sendable contacts, also hand out contacts whose email
  // is not known yet (emailStatus `unknown`), for the caller to look it up and write
  // it back (crmWriteEmailLookup). Absent = no key on the wire.
  includeEmailUnknown?: boolean;
}

export interface CrmServeStats {
  served: number;
  remainingSendable: number;
  totalSendable: number;
  // Present only when the filter's segment names dealStages (crm-service adds it).
  byStage?: CrmStageStats[];
}

export interface CrmServeNextResult {
  contacts: CrmContact[];
  served: number;
  // True when no un-served sendable contacts remain for the brand after this call.
  exhausted: boolean;
}

// One imported CRM file (a crm-service upload) of a brand. Only the fields
// human-service needs to validate an audience's source binding are declared.
export interface CrmUpload {
  id: string;
  brandId: string;
  filename: string;
  rowCount: number;
  status: string;
}

// List the brand's imported CRM sources. Used to VALIDATE an audience's
// `crmUploadId` binding at creation — binding to an upload that is not this
// brand's would silently serve nothing (or, worse, another brand's people), so
// we check it up front and reject loudly rather than persisting a dead pointer.
export async function crmListUploads(
  brandId: string,
  identity: Identity
): Promise<CrmUpload[]> {
  const { url, key } = requireCrm();
  const target = `${url}/orgs/contacts/uploads?brandId=${encodeURIComponent(brandId)}`;
  let res: Response;
  try {
    res = await fetchWithConnectRetry(target, {
      method: "GET",
      headers: downstreamHeaders(key, identity),
    });
  } catch (err) {
    throw new ProviderError("crm", 0, errorString(err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError("crm", res.status, text);
  }
  const data = (await res.json()) as { uploads?: CrmUpload[] };
  return Array.isArray(data.uploads) ? data.uploads : [];
}

// Serve the next `limit` not-yet-served contacts for a brand. crm-service marks
// them served atomically, so a caller must be prepared to deliver every returned
// contact (a burned contact never comes back). serveNextPerson calls this with
// limit 1 to minimize the marked-served-but-undelivered window (mirrors apify's
// billed-per-lead strict minimum).
//
// `uploadId` restricts the serve to ONE imported CRM file of the brand — the
// audience's source binding. crm-service takes a LIST (`uploadIds`), because it
// supports restricting to a subset of files; a human-service audience is bound to
// exactly one source, so we send a single-element list. Omitted (unbound
// audience) ⟹ the request body is byte-identical to before and crm-service serves
// the whole brand. The brand-wide no-re-serve guarantee is crm-service's and is
// unaffected by the restriction: a person present in two files is still served at
// most once for the brand.
//
// `scope.people` switches the serve to crm-service's PEOPLE pool under that
// filter (`people: {...}` on the body). Same brand-wide no-re-serve forever.
export async function crmServeNext(
  brandId: string,
  limit: number,
  identity: Identity,
  scope: CrmServeScope = {}
): Promise<CrmServeNextResult> {
  const { url, key } = requireCrm();
  const uploadId = scope.uploadId ?? null;
  const people = scope.people ?? null;
  const reachableBy = scope.reachableBy && scope.reachableBy.length > 0 ? [...scope.reachableBy] : null;
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/orgs/contacts/serve-next`, {
      method: "POST",
      headers: downstreamHeaders(key, identity),
      body: JSON.stringify({
        brandId,
        limit,
        ...(uploadId ? { uploadIds: [uploadId] } : {}),
        ...(people ? { people } : {}),
        ...(reachableBy ? { reachableBy } : {}),
        ...(scope.relationships ? { relationships: scope.relationships } : {}),
        ...(scope.stepFilter ? { stepFilter: scope.stepFilter } : {}),
        ...(scope.includeEmailUnknown ? { includeEmailUnknown: true } : {}),
      }),
    });
  } catch (err) {
    throw new ProviderError("crm", 0, errorString(err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError("crm", res.status, text);
  }
  const data = (await res.json()) as {
    contacts?: CrmContact[];
    served?: number;
    exhausted?: boolean;
  };
  return {
    contacts: Array.isArray(data.contacts) ? data.contacts : [],
    served: typeof data.served === "number" ? data.served : 0,
    exhausted: data.exhausted === true,
  };
}

// Hand out the next contact of the brand's CRM pool to ONE asker (an offer
// audience) WITHOUT burning it (crm-service v0.121.0, AUDIENCE-PER-OFFER-1107):
// the body is serve-next's plus `asker`. Out: anyone burned for the brand and
// anyone already handed to this asker; another asker of the brand still gets them.
export async function crmHandOut(
  brandId: string,
  asker: string,
  limit: number,
  identity: Identity,
  scope: CrmServeScope = {}
): Promise<{ contacts: CrmContact[]; exhausted: boolean }> {
  const { url, key } = requireCrm();
  const reachableBy = scope.reachableBy && scope.reachableBy.length > 0 ? [...scope.reachableBy] : null;
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/orgs/contacts/hand-outs`, {
      method: "POST",
      headers: downstreamHeaders(key, identity),
      body: JSON.stringify({
        brandId,
        asker,
        limit,
        ...(scope.uploadId ? { uploadIds: [scope.uploadId] } : {}),
        ...(scope.people ? { people: scope.people } : {}),
        ...(reachableBy ? { reachableBy } : {}),
        ...(scope.relationships ? { relationships: scope.relationships } : {}),
        ...(scope.stepFilter ? { stepFilter: scope.stepFilter } : {}),
        ...(scope.includeEmailUnknown ? { includeEmailUnknown: true } : {}),
      }),
    });
  } catch (err) {
    throw new ProviderError("crm", 0, errorString(err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError("crm", res.status, text);
  }
  const data = (await res.json()) as { contacts?: CrmContact[]; exhausted?: boolean };
  const contacts = Array.isArray(data.contacts) ? data.contacts : [];
  for (const c of contacts) {
    if (typeof c.handOutId !== "string") throw new ProviderError("crm", 502, "hand-out without a handOutId");
  }
  return { contacts, exhausted: data.exhausted === true };
}

/** Serve a hand-out: the contact is burned for the brand. 409s are settled answers. */
export async function crmServeHandOut(
  handOutId: string,
  brandId: string,
  identity: Identity
): Promise<"served" | "already_served" | "declined" | "email_unknown"> {
  return handOutDecision(handOutId, "serve", { brandId }, identity, ["already_served", "declined", "email_unknown"]) as Promise<
    "served" | "already_served" | "declined" | "email_unknown"
  >;
}

/** Decline a hand-out: this asker is not offered the contact again; others still are. */
export async function crmDeclineHandOut(
  handOutId: string,
  brandId: string,
  reason: string,
  identity: Identity
): Promise<"declined" | "already_served"> {
  return handOutDecision(handOutId, "decline", { brandId, reason }, identity, ["already_served"]) as Promise<
    "declined" | "already_served"
  >;
}

async function handOutDecision(
  handOutId: string,
  action: "serve" | "decline",
  body: Record<string, unknown>,
  identity: Identity,
  settled409: string[]
): Promise<string> {
  const { url, key } = requireCrm();
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/orgs/contacts/hand-outs/${encodeURIComponent(handOutId)}/${action}`, {
      method: "POST",
      headers: downstreamHeaders(key, identity),
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ProviderError("crm", 0, errorString(err));
  }
  if (res.status === 409) {
    const data = (await res.json().catch(() => null)) as { type?: string } | null;
    if (data?.type && settled409.includes(data.type)) return data.type;
    throw new ProviderError("crm", 409, JSON.stringify(data));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError("crm", res.status, text);
  }
  const data = (await res.json()) as { status?: string };
  if (data.status !== (action === "serve" ? "served" : "declined")) {
    throw new ProviderError("crm", 502, `hand-out ${action} answered ${JSON.stringify(data)}`);
  }
  return data.status;
}

// Write the email lookup of a handed-out email-unknown contact back to crm-service
// (POST /orgs/contacts/{contactId}/email-lookup). `found` gives the contact its
// address AND marks it served for the brand (the hand-out was its serve);
// `not_found` means it is never handed out again. Idempotent there. A 409
// `email_already_known` (the contact got an address meanwhile) is a settled
// answer, not a failure: returned as such. Anything else non-2xx fails loud.
export interface CrmEmailLookupResult {
  status: "found" | "not_found" | "already_known";
  duplicateOf: string | null;
}

export async function crmWriteEmailLookup(
  contactId: string,
  brandId: string,
  outcome: { status: "found"; email: string } | { status: "not_found" },
  identity: Identity
): Promise<CrmEmailLookupResult> {
  const { url, key } = requireCrm();
  let res: Response;
  try {
    res = await fetchWithConnectRetry(
      `${url}/orgs/contacts/${encodeURIComponent(contactId)}/email-lookup`,
      {
        method: "POST",
        headers: downstreamHeaders(key, identity),
        body: JSON.stringify({ brandId, ...outcome }),
      }
    );
  } catch (err) {
    throw new ProviderError("crm", 0, errorString(err));
  }
  if (res.status === 409) {
    const text = await res.text().catch(() => "");
    if (text.includes("email_already_known")) return { status: "already_known", duplicateOf: null };
    throw new ProviderError("crm", 409, text);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError("crm", res.status, text);
  }
  const data = (await res.json()) as { duplicateOf?: unknown };
  return {
    status: outcome.status,
    duplicateOf: typeof data.duplicateOf === "string" ? data.duplicateOf : null,
  };
}

// How many people a PEOPLE-pool filter holds for the brand, read-only (crm-service
// GET /orgs/contacts/serve-stats?pool=people&...). Burns nobody, so it is what
// validates a filter at audience creation and what feeds the audience's Size /
// Remaining. Fail loud like every crm call (ProviderError → 502 at the route).
export async function crmPeopleServeStats(
  brandId: string,
  filter: CrmPeopleFilter,
  identity: Identity
): Promise<CrmServeStats> {
  const { url, key } = requireCrm();
  const q = new URLSearchParams({ brandId, pool: "people" });
  if (filter.signedUp !== undefined) q.set("signedUp", String(filter.signedUp));
  if (filter.replied !== undefined) q.set("replied", String(filter.replied));
  if (filter.reachableBy !== undefined) q.set("reachableBy", filter.reachableBy);
  if (filter.segment !== undefined) q.set("segment", JSON.stringify(filter.segment));
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/orgs/contacts/serve-stats?${q.toString()}`, {
      method: "GET",
      headers: downstreamHeaders(key, identity),
    });
  } catch (err) {
    throw new ProviderError("crm", 0, errorString(err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError("crm", res.status, text);
  }
  const data = (await res.json()) as Partial<CrmServeStats> & { byStage?: unknown };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const served = num(data.served);
  const remainingSendable = num(data.remainingSendable);
  const totalSendable = num(data.totalSendable);
  if (served === null || remainingSendable === null || totalSendable === null) {
    throw new ProviderError("crm", res.status, `serve-stats answered without counts: ${JSON.stringify(data)}`);
  }
  if (data.byStage === undefined) return { served, remainingSendable, totalSendable };
  if (!Array.isArray(data.byStage)) {
    throw new ProviderError("crm", res.status, `serve-stats byStage is not a list: ${JSON.stringify(data.byStage)}`);
  }
  const byStage = data.byStage.map((raw) => {
    const e = raw as Partial<CrmStageStats>;
    const s = num(e.served);
    const r = num(e.remainingSendable);
    const t = num(e.totalSendable);
    if (typeof e.stage !== "string" || s === null || r === null || t === null) {
      throw new ProviderError("crm", res.status, `serve-stats byStage entry without counts: ${JSON.stringify(raw)}`);
    }
    return {
      pipeline: typeof e.pipeline === "string" ? e.pipeline : null,
      stage: e.stage,
      served: s,
      remainingSendable: r,
      totalSendable: t,
    };
  });
  return { served, remainingSendable, totalSendable, byStage };
}

// Does ONE person still belong to a crm-service pool, right now? (crm-service
// POST /orgs/contacts/still-fits, the SAME rule its serve applies.) A question:
// crm-service marks nobody. `null` = crm-service holds nobody at this address
// (its 404). Anything else non-2xx / unreadable fails loud (ProviderError → 502).
export interface CrmStillFitsScope {
  people?: CrmPeopleFilter;
  uploadIds?: string[];
  stepFilter?: StepFilter;
}

export type CrmStillFits =
  | { fits: true }
  | { fits: false; reason: string; failed: { code: string; reason: string }[] };

export async function crmStillFits(
  brandId: string,
  email: string,
  scope: CrmStillFitsScope,
  identity: Identity
): Promise<CrmStillFits | null> {
  const { url, key } = requireCrm();
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/orgs/contacts/still-fits`, {
      method: "POST",
      headers: downstreamHeaders(key, identity),
      body: JSON.stringify({
        brandId,
        email,
        ...(scope.people ? { people: scope.people } : {}),
        ...(scope.uploadIds && scope.uploadIds.length > 0 ? { uploadIds: scope.uploadIds } : {}),
        ...(scope.stepFilter ? { stepFilter: scope.stepFilter } : {}),
      }),
    });
  } catch (err) {
    throw new ProviderError("crm", 0, errorString(err));
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError("crm", res.status, text);
  }
  const data = (await res.json()) as { fits?: unknown; reason?: unknown; failed?: unknown };
  if (data.fits === true) return { fits: true };
  if (data.fits === false && typeof data.reason === "string" && data.reason.length > 0) {
    const failed = Array.isArray(data.failed)
      ? data.failed.filter(
          (f): f is { code: string; reason: string } =>
            !!f && typeof (f as { code?: unknown }).code === "string" && typeof (f as { reason?: unknown }).reason === "string"
        )
      : [];
    return { fits: false, reason: data.reason, failed };
  }
  throw new ProviderError("crm", res.status, `still-fits answered without a verdict: ${JSON.stringify(data)}`);
}

// Map a crm-service contact to the neutral Person shape the serve-next contract
// returns (field names mirror lead-service FullLead). crm carries only identity +
// email + phone — no title/seniority/company/social — so those are null. The
// phone (crm's `phoneE164`) rides as `phone`, present ONLY when crm-service holds
// one: a channel that writes on WhatsApp / SMS reads it, and every other
// provider's served bytes stay unchanged (the key is absent there).
export function normalizeCrmContact(c: CrmContact): Person {
  const name =
    c.fullName ??
    ([c.firstName, c.lastName].filter(Boolean).join(" ") || null);
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    name,
    title: null,
    headline: null,
    seniority: null,
    email: c.primaryEmail,
    emailStatus: null,
    catchAll: null,
    inferred: null,
    linkedinUrl: null,
    photoUrl: null,
    city: null,
    state: null,
    country: null,
    timezone: null,
    // crm-service contacts carry no geography, so there is no language signal —
    // empty is the honest answer and the consumer handles unknown.
    businessLanguages: [],
    provider: "crm",
    // crm's own contact id — provenance only (crm has no enrich-by-id path).
    providerPersonId: c.id,
    organization: null,
    // crm-service contacts carry no career history; absent stays absent.
    employmentHistory: null,
    // a client's uploaded contact carries no buying signal.
    buyingSignal: null,
    ...(c.phoneE164 ? { phone: c.phoneE164 } : {}),
  };
}

// Can the brand's WhatsApp reach this number right now? crm-service OWNS the
// answer (POST /orgs/whatsapp/reach: the brand's linked + connected accounts, then
// one WhatsApp bridge lookup of the number). Checks only: no message, no send row,
// no cost. Never guessed from the number here (GMAPS-SOURCE-1103).
export type WhatsappReach =
  | { reachable: true }
  | {
      reachable: false;
      code:
        | "whatsapp_not_linked"
        | "whatsapp_not_connected"
        | "automation_not_allowed"
        | "no_phone_known"
        | "not_on_whatsapp"
        | "stated_not_to_brand"
        | "person_replied"
        | "human_in_conversation";
      error: string;
    };

export async function crmWhatsappReach(brandId: string, phone: string, identity: Identity): Promise<WhatsappReach> {
  const { url, key } = requireCrm();
  const endpoint = `${url}/orgs/whatsapp/reach`;
  let res: Response;
  try {
    res = await fetchWithConnectRetry(endpoint, {
      method: "POST",
      headers: { ...downstreamHeaders(key, identity), "x-brand-id": brandId },
      body: JSON.stringify({ brandId, phone }),
    });
  } catch (err) {
    throw new ProviderError("crm", 0, `crm-service whatsapp/reach unreachable: ${errorString(err)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new ProviderError("crm", res.status, text.slice(0, 500));
  const body = JSON.parse(text) as { reachable?: unknown; code?: unknown; error?: unknown };
  if (body.reachable === true) return { reachable: true };
  if (body.reachable === false && typeof body.code === "string") {
    return { reachable: false, code: body.code as Extract<WhatsappReach, { reachable: false }>["code"], error: String(body.error ?? "") };
  }
  throw new ProviderError("crm", 502, `crm-service whatsapp/reach answered an unreadable body: ${text.slice(0, 300)}`);
}
