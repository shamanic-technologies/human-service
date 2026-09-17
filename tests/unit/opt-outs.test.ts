import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

import {
  isEmailOptedOut,
  listStandingOptOutEmails,
  OptOutConfigError,
  OptOutSourceError,
} from "../../src/lib/instantly-optouts.js";
import {
  filterOptedOut,
  matchesOptOut,
  type OptOutExclusions,
} from "../../src/services/opt-outs.js";

const fetchSpy = vi.fn();
const fetchBeforeThisSuite = globalThis.fetch;

const identity = { orgId: "org-1", userId: "user-1" } as never;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  process.env.INSTANTLY_SERVICE_URL = "http://instantly:8080";
  process.env.INSTANTLY_SERVICE_API_KEY = "instantly-key";
});

afterAll(() => {
  globalThis.fetch = fetchBeforeThisSuite;
});

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

function row(email: string, withdrawnAt: string | null = null) {
  return { email, withdrawnAt };
}

describe("reading the org's consent log", () => {
  it("asks instantly-service for the STANDING records only", async () => {
    fetchSpy.mockResolvedValue(ok({ optOuts: [row("A@Example.com")] }));
    const emails = await listStandingOptOutEmails(identity);

    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("/orgs/opt-outs");
    expect(url).toContain("standing_only=true");
    // Normalized to the same trim+lowercase both services compare under, so a
    // record written as `A@Example.com` still matches a lead stored lowercase.
    expect(emails).toEqual(["a@example.com"]);
  });

  it("drops a WITHDRAWN record — the person is back in the pool", async () => {
    fetchSpy.mockResolvedValue(
      ok({
        optOuts: [
          row("stands@x.com"),
          row("withdrawn@x.com", "2026-09-01T00:00:00.000Z"),
        ],
      })
    );
    expect(await listStandingOptOutEmails(identity)).toEqual(["stands@x.com"]);
  });

  it("REFUSES a truncated read rather than returning a short list", async () => {
    // The endpoint caps at 500 with no cursor. A full page means there may be
    // opt-outs we did not see, and a gate missing entries emits somebody who
    // asked us to stop — so this is an error, not a shorter answer.
    fetchSpy.mockResolvedValue(
      ok({ optOuts: Array.from({ length: 500 }, (_, i) => row(`p${i}@x.com`)) })
    );
    await expect(listStandingOptOutEmails(identity)).rejects.toBeInstanceOf(
      OptOutSourceError
    );
  });

  it("fails loud on an upstream error — never an empty set", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "down",
    });
    await expect(listStandingOptOutEmails(identity)).rejects.toBeInstanceOf(
      OptOutSourceError
    );
  });

  it("fails loud when the source is not configured", async () => {
    delete process.env.INSTANTLY_SERVICE_URL;
    await expect(listStandingOptOutEmails(identity)).rejects.toBeInstanceOf(
      OptOutConfigError
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("isEmailOptedOut asks for the one address, and is false when nothing stands", async () => {
    fetchSpy.mockResolvedValue(ok({ optOuts: [] }));
    expect(await isEmailOptedOut(identity, " Stop@X.com ")).toBe(false);
    expect(String(fetchSpy.mock.calls[0][0])).toContain(
      `email=${encodeURIComponent("stop@x.com")}`
    );
  });

  it("isEmailOptedOut is true when a standing record comes back", async () => {
    fetchSpy.mockResolvedValue(ok({ optOuts: [row("stop@x.com")] }));
    expect(await isEmailOptedOut(identity, "stop@x.com")).toBe(true);
  });

  it("an absent email is not a lookup and not an opt-out", async () => {
    expect(await isEmailOptedOut(identity, null)).toBe(false);
    expect(await isEmailOptedOut(identity, "  ")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("matching a candidate against the standing set", () => {
  const exclusions: OptOutExclusions = {
    emails: new Set(["stop@x.com"]),
    linkedinUrls: new Set(["linkedin.com/in/stopper"]),
    personIds: new Set(["apollo-stop"]),
  };

  it("matches on the email", () => {
    expect(matchesOptOut(exclusions, { email: " STOP@x.com " })).toBe(true);
  });

  it("matches on the linkedin url a free teaser carries, normalized", () => {
    expect(
      matchesOptOut(exclusions, {
        linkedinUrl: "https://www.linkedin.com/in/stopper/?ref=1",
      })
    ).toBe(true);
  });

  it("matches on the provider person id", () => {
    expect(matchesOptOut(exclusions, { providerPersonId: "apollo-stop" })).toBe(
      true
    );
  });

  it("an unrelated candidate is untouched, and absent keys never match", () => {
    expect(
      matchesOptOut(exclusions, {
        email: "someone@else.com",
        linkedinUrl: null,
        providerPersonId: null,
      })
    ).toBe(false);
    expect(matchesOptOut(exclusions, {})).toBe(false);
  });

  it("filterOptedOut drops exactly the matched candidates", () => {
    const items = [
      { providerPersonId: "apollo-stop", linkedinUrl: null },
      { providerPersonId: "apollo-ok", linkedinUrl: null },
      { providerPersonId: null, linkedinUrl: "linkedin.com/in/stopper" },
    ];
    expect(filterOptedOut(exclusions, items)).toEqual([items[1]]);
  });

  it("an empty set is a pass-through, allocating nothing", () => {
    const items = [{ providerPersonId: "p1", linkedinUrl: null }];
    expect(
      filterOptedOut(
        { emails: new Set(), linkedinUrls: new Set(), personIds: new Set() },
        items
      )
    ).toBe(items);
  });
});
