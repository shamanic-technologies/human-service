// Shared bounce-source mock. The serve path asks instantly-service which of the
// addresses it can tie to a candidate bounced on one of our sends, and fails
// loud when it cannot — so every suite that exercises a serve with a real DB has
// to answer this call, exactly as prod does.
//
// Default answer: nobody bounced, which keeps those suites about their subject.

export function isBounceUrl(url: string): boolean {
  return String(url).includes("/internal/bounced-emails");
}

// Build the response instantly-service would give for this request body, from a
// set of bounced addresses (case-insensitive, like the producer).
export function bounceResponse(
  body: string | undefined,
  bouncedEmails: string[] = []
): { bounced: { email: string; firstBouncedAt: string }[] } {
  const asked = (JSON.parse(body ?? "{}").emails ?? []) as string[];
  const dead = new Set(bouncedEmails.map((e) => e.trim().toLowerCase()));
  return {
    bounced: asked
      .map((e) => e.trim().toLowerCase())
      .filter((e) => dead.has(e))
      .map((email) => ({ email, firstBouncedAt: "2026-09-01T00:00:00.000Z" })),
  };
}

// Module-level stub for suites that mock the gateway's other exclusion sources
// at module level: the bounce gate becomes a no-op.
export const noBouncesModule = {
  filterBounced: async <T>(_identity: unknown, items: T[]) => items,
  isEmailBounced: async () => false,
};
