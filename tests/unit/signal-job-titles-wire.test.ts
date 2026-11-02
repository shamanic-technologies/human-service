// HIRING-TITLES-1102: what reaches apollo-service. No titles = the exact body sent
// before (no jobTitles key); titles ride signal.jobTitles (hiring only) and the
// coverage read's top-level jobTitles.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  createApolloSignalAudience,
  measureSignalCoverage,
  readSignalJobTitles,
} from "../../src/lib/apollo-audiences.js";

const identity = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" } as never;
const fetchBefore = globalThis.fetch;
const fetchSpy = vi.fn();

function body(i = 0) {
  return JSON.parse(fetchSpy.mock.calls[i][1].body as string);
}

beforeEach(() => {
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "k";
  fetchSpy.mockReset().mockImplementation(async (url: string) => {
    const payload = url.endsWith("/audiences/signal")
      ? { apolloAudienceId: "a1", filters: { buying_signal: { type: "hiring", window_days: 30 } }, count: 5 }
      : { baseCount: 1, signals: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterAll(() => {
  globalThis.fetch = fetchBefore;
});

describe("signal job titles on the wire", () => {
  it("no titles: signal carries type + windowDays only", async () => {
    await createApolloSignalAudience({ baseApolloAudienceId: "b", brandId: "br", name: "n", type: "hiring", windowDays: 30, identity });
    expect(body().signal).toEqual({ type: "hiring", windowDays: 30 });
    await measureSignalCoverage({ apolloAudienceId: "b", windowDays: [30, 90], identity });
    expect(body(1)).toEqual({ apolloAudienceId: "b", windowDays: [30, 90] });
  });

  it("titles: forwarded for hiring, never for another signal", async () => {
    await createApolloSignalAudience({ baseApolloAudienceId: "b", brandId: "br", name: "n", type: "hiring", windowDays: 30, jobTitles: ["QA", "SDET"], identity });
    expect(body().signal).toEqual({ type: "hiring", windowDays: 30, jobTitles: ["QA", "SDET"] });
    await createApolloSignalAudience({ baseApolloAudienceId: "b", brandId: "br", name: "n", type: "funding", windowDays: 90, jobTitles: ["QA"], identity });
    expect(body(1).signal).toEqual({ type: "funding", windowDays: 90 });
    await measureSignalCoverage({ apolloAudienceId: "b", windowDays: [30], jobTitles: ["QA"], identity });
    expect(body(2).jobTitles).toEqual(["QA"]);
  });

  it("readSignalJobTitles reads a hiring signal's titles only", () => {
    expect(readSignalJobTitles({ buying_signal: { type: "hiring", window_days: 30, job_titles: ["QA"] } })).toEqual(["QA"]);
    expect(readSignalJobTitles({ buying_signal: { type: "hiring", window_days: 30 } })).toBeNull();
    expect(readSignalJobTitles({ buying_signal: { type: "funding", job_titles: ["QA"] } })).toBeNull();
    expect(readSignalJobTitles(null)).toBeNull();
  });
});
