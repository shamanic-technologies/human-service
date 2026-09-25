import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// The gate under test: after the billed reveal, finalizeResolved asks the
// verifier and serves only a deliverable address.
const verification = vi.hoisted(() => ({ verifyEmail: vi.fn() }));
vi.mock("../../src/lib/email-verification.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  verifyEmail: verification.verifyEmail,
}));

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

function enriched(email: string | null) {
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
    }),
  };
}

describe("pre-serve email verification", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
    process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
    supp.isEmailSuppressed.mockResolvedValue(false);
    supp.recordServe.mockResolvedValue(undefined);
  });

  it.each(["valid"])("serves a %s address and records the verdict", async (verdict) => {
    fetchSpy.mockResolvedValueOnce(enriched("jane@acme.com"));
    verification.verifyEmail.mockResolvedValue(verdict);
    const r = await resolveEmail({ providerPersonId: "a1", identity });
    expect(r.person?.email).toBe("jane@acme.com");
    expect(verification.verifyEmail).toHaveBeenCalledWith(
      "jane@acme.com",
      expect.objectContaining({ orgId: "org-1", userId: "user-1" })
    );
    expect(supp.recordServe.mock.calls[0][3]).toMatchObject({ emailVerdict: verdict });
  });

  it.each(["catch_all", "invalid", "unknown", "risky"])(
    "drops a %s address, but still records the paid reveal so it is never re-bought",
    async (verdict) => {
      fetchSpy.mockResolvedValueOnce(enriched("jane@acme.com"));
      verification.verifyEmail.mockResolvedValue(verdict);
      const r = await resolveEmail({ providerPersonId: "a1", identity });
      expect(r.person).toBeNull();
      expect(supp.recordServe).toHaveBeenCalledTimes(1);
      expect(supp.recordServe.mock.calls[0][3]).toMatchObject({ emailVerdict: verdict });
    }
  );

  it("never pays to verify someone already suppressed for the brand", async () => {
    fetchSpy.mockResolvedValueOnce(enriched("jane@acme.com"));
    supp.isEmailSuppressed.mockResolvedValue(true);
    const r = await resolveEmail({ providerPersonId: "a1", identity });
    expect(r.person).toBeNull();
    expect(verification.verifyEmail).not.toHaveBeenCalled();
  });

  it("does not verify a reveal with no address (the caller's no-email drop handles it)", async () => {
    fetchSpy.mockResolvedValueOnce(enriched(null));
    await resolveEmail({ providerPersonId: "a1", identity });
    expect(verification.verifyEmail).not.toHaveBeenCalled();
  });

  it("a verification failure fails the serve — never serves unverified", async () => {
    fetchSpy.mockResolvedValueOnce(enriched("jane@acme.com"));
    verification.verifyEmail.mockRejectedValue(new EmailVerificationError("apify down"));
    await expect(resolveEmail({ providerPersonId: "a1", identity })).rejects.toBeInstanceOf(
      EmailVerificationError
    );
    expect(supp.recordServe).not.toHaveBeenCalled();
  });
});
