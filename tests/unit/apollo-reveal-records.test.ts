import { describe, it, expect, vi, afterEach } from "vitest";
import { readApolloRevealRecords, RevealRecordSourceError } from "../../src/lib/apollo-reveal-records.js";

const fetchBefore = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchBefore;
});

function answer(body: unknown, status = 200) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe("readApolloRevealRecords", () => {
  it("reads both directions of apollo-service's served shape", async () => {
    process.env.APOLLO_SERVICE_URL = "http://apollo";
    process.env.APOLLO_SERVICE_API_KEY = "k";
    const spy = answer({
      people: [
        { apolloPersonId: "p1", emails: [{ email: "M.Kool@elvacenter.com", reveals: 1 }], unambiguousEmail: "m.kool@elvacenter.com" },
        { apolloPersonId: "p2", emails: [], unambiguousEmail: null },
      ],
      emails: [{ email: "m.kool@elvacenter.com", apolloPersonIds: ["p1"] }],
    });
    const r = await readApolloRevealRecords(["p1", "p2"]);
    expect(r.emailsByPersonId.get("p1")).toEqual(["m.kool@elvacenter.com"]);
    expect(r.emailsByPersonId.get("p2")).toEqual([]);
    expect(r.personIdsByEmail.get("m.kool@elvacenter.com")).toEqual(["p1"]);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://apollo/internal/reveal-records/by-person-ids");
    expect(JSON.parse(init.body as string)).toEqual({ apolloPersonIds: ["p1", "p2"] });
  });

  it("fails loud on a non-2xx and on a body it cannot read", async () => {
    process.env.APOLLO_SERVICE_URL = "http://apollo";
    process.env.APOLLO_SERVICE_API_KEY = "k";
    answer({ error: "x" }, 500);
    await expect(readApolloRevealRecords(["p1"])).rejects.toBeInstanceOf(RevealRecordSourceError);
    answer({ people: [] });
    await expect(readApolloRevealRecords(["p1"])).rejects.toBeInstanceOf(RevealRecordSourceError);
  });
});
