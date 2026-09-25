import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// The gate under test: after the billed reveal, finalizeResolved reads the
// provider's own verdict (apollo-service `emailVerification`) and serves only a
// deliverable address.
const supp = vi.hoisted(() => ({
  filterSuppressed: vi.fn(),
  getSuppressionSet: vi.fn(),
  isEmailSuppressed: vi.fn(),
  recordServe: vi.fn(),
}));
vi.mock("../../src/services/suppression.js", () => supp);
vi.mock("../../src/lib/lead-won.js", () => ({
  listWonEmails: vi.fn(async () => []),
  isEmailWon: vi.fn(async () => false),
  WonLeadsSourceError: class WonLeadsSourceError extends Error {},
  WonLeadsConfigError: class WonLeadsConfigError extends Error {},
}));
vi.mock("../../src/lib/instantly-optouts.js", () => ({
  listStandingOptOutEmails: vi.fn(async () => []),
  isEmailOptedOut: vi.fn(async () => false),
  OptOutSourceError: class OptOutSourceError extends Error {},
  OptOutConfigError: class OptOutConfigError extends Error {},
}));

import { resolveEmail } from "../../src/services/people-providers.js";
import { EmailVerificationError } from "../../src/lib/email-verification.js";

const fetchBefore = globalThis.fetch;
const fetchSpy = vi.fn();
afterAll(() => {
  vi.stubGlobal("fetch", fetchBefore);
});

const identity = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
  brandIds: ["brand-A"],
};

function enriched(email: string | null, emailVerification: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({
      enrichmentId: "e1",
      cached: false,
      person: {
        id: "a1", firstName: "Jane", lastName: "Doe", name: "Jane Doe",
        email, emailStatus: "verified", title: null, headline: null,
        seniority: null, linkedinUrl: null, photoUrl: null, city: null, state: null, country: null,
        organizationName: null, organizationDomain: "acme.com", organizationWebsiteUrl: null,
        organizationIndustry: null, organizationSize: null, organizationLinkedinUrl: null,
        organizationLogoUrl: null, organizationCity: null, organizationState: null, organizationCountry: null,
      },
      ...(emailVerification === undefined ? {} : { emailVerification }),
    }),
  };
}

const verdict = (v: string, deliverable: boolean) => ({
  email: "jane@acme.com",
  verdict: v,
  deliverable,
  verifier: "bounceverify",
  verificationId: "ver-1",
  verifiedAt: "2026-09-25T00:00:00Z",
  reused: false,
});

describe("serve gate on the provider's email verification", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
    process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
    supp.isEmailSuppressed.mockResolvedValue(false);
    supp.recordServe.mockResolvedValue(undefined);
  });

  it("serves a deliverable address and records the verdict", async () => {
    fetchSpy.mockResolvedValueOnce(enriched("jane@acme.com", verdict("valid", true)));
    const r = await resolveEmail({ providerPersonId: "a1", identity });
    expect(r.person?.email).toBe("jane@acme.com");
    expect(supp.recordServe.mock.calls[0][3]).toMatchObject({ emailVerdict: "valid" });
  });

  it.each(["catch_all", "invalid", "unknown", "risky"])(
    "drops a non-deliverable (%s) address, but records the paid reveal so it is never re-bought",
    async (v) => {
      fetchSpy.mockResolvedValueOnce(enriched("jane@acme.com", verdict(v, false)));
      const r = await resolveEmail({ providerPersonId: "a1", identity });
      expect(r.person).toBeNull();
      expect(supp.recordServe).toHaveBeenCalledTimes(1);
      expect(supp.recordServe.mock.calls[0][3]).toMatchObject({ emailVerdict: v });
    }
  );

  it("an email without a verdict fails loud — never served unverified", async () => {
    fetchSpy.mockResolvedValueOnce(enriched("jane@acme.com", undefined));
    await expect(resolveEmail({ providerPersonId: "a1", identity })).rejects.toBeInstanceOf(
      EmailVerificationError
    );
    expect(supp.recordServe).not.toHaveBeenCalled();
  });

  it("a reveal with no address needs no verdict (the caller's no-email drop handles it)", async () => {
    fetchSpy.mockResolvedValueOnce(enriched(null, null));
    await expect(resolveEmail({ providerPersonId: "a1", identity })).resolves.toBeDefined();
  });
});
