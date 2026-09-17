// Shared opt-out-source mock. The serve path reads the org's consent log from
// instantly-service on EVERY serve and fails loud when it cannot — so every
// suite that exercises a serve has to answer this call, exactly as prod does.
//
// Default answer is an empty log, which is what almost every test wants: it
// makes the gate a no-op and keeps those suites about what they are about.

export const INSTANTLY_TEST_URL = "http://instantly:8080";

export function setOptOutEnv(): void {
  process.env.INSTANTLY_SERVICE_URL = INSTANTLY_TEST_URL;
  process.env.INSTANTLY_SERVICE_API_KEY = "instantly-key";
}

export function isOptOutUrl(url: string): boolean {
  return String(url).includes("/orgs/opt-outs");
}

// Build the response instantly-service would give for this URL, from a set of
// standing opt-out addresses. Honours `?email=` (the exact single lookup) so a
// test can assert the post-reveal block without the list path interfering.
export function optOutResponse(
  url: string,
  standingEmails: string[] = []
): { optOuts: { email: string; withdrawnAt: string | null }[] } {
  const query = String(url).split("?")[1] ?? "";
  const params = new URLSearchParams(query);
  const wanted = params.get("email");
  const rows = standingEmails.map((email) => ({ email, withdrawnAt: null }));
  return {
    optOuts: wanted
      ? rows.filter((r) => r.email.toLowerCase() === wanted.toLowerCase())
      : rows,
  };
}
