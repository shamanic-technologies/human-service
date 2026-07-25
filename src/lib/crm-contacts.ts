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

import {
  downstreamHeaders,
  fetchWithConnectRetry,
  ProviderConfigError,
  ProviderError,
  type Identity,
  type Person,
} from "../services/people-providers.js";

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
    throw new ProviderError("crm", 0, String(err));
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
export async function crmServeNext(
  brandId: string,
  limit: number,
  identity: Identity,
  uploadId?: string | null
): Promise<CrmServeNextResult> {
  const { url, key } = requireCrm();
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/orgs/contacts/serve-next`, {
      method: "POST",
      headers: downstreamHeaders(key, identity),
      body: JSON.stringify({
        brandId,
        limit,
        ...(uploadId ? { uploadIds: [uploadId] } : {}),
      }),
    });
  } catch (err) {
    throw new ProviderError("crm", 0, String(err));
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

// Map a crm-service contact to the neutral Person shape the serve-next contract
// returns (field names mirror lead-service FullLead). crm carries only identity +
// email — no title/seniority/company/social — so those are null.
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
    provider: "crm",
    // crm's own contact id — provenance only (crm has no enrich-by-id path).
    providerPersonId: c.id,
    organization: null,
  };
}
