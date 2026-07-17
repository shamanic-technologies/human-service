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

// Serve the next `limit` not-yet-served contacts for a brand. crm-service marks
// them served atomically, so a caller must be prepared to deliver every returned
// contact (a burned contact never comes back). serveNextPerson calls this with
// limit 1 to minimize the marked-served-but-undelivered window (mirrors apify's
// billed-per-lead strict minimum).
export async function crmServeNext(
  brandId: string,
  limit: number,
  identity: Identity
): Promise<CrmServeNextResult> {
  const { url, key } = requireCrm();
  let res: Response;
  try {
    res = await fetchWithConnectRetry(`${url}/orgs/contacts/serve-next`, {
      method: "POST",
      headers: downstreamHeaders(key, identity),
      body: JSON.stringify({ brandId, limit }),
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
