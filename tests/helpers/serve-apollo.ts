import request from "supertest";
import type { Express } from "express";
import { getAuthHeaders } from "./test-app.js";

// Since 2026-10-07 an apollo audience is served ONLY through the candidate API
// (serve-next answers 422 for it): next (free) → reveal (billed). This walks it
// the way lead-service does with a screen that accepts everyone, so the suites
// that used to drive apollo through serve-next keep asserting the same serve
// behaviour (free gates at next, post-pay gates + served contract at reveal).
//
// Returns a supertest-like `{ status, body }`: body is serve-next's shape
// (`{status: "served", person, personId}` or `{status: "exhausted", person:
// null}`), or the failing response as-is when a step answers non-200.
export async function serveApollo(
  app: Express,
  audienceId: string,
  headers: Record<string, string> = getAuthHeaders(),
  maxReveals = 50
): Promise<{ status: number; body: any; reveals: number }> {
  let reveals = 0;
  for (;;) {
    const next = await request(app)
      .post(`/orgs/audiences/${audienceId}/candidates/next`)
      .set(headers);
    if (next.status !== 200) return { status: next.status, body: next.body, reveals };
    if (next.body.status === "exhausted") {
      return { status: 200, body: { status: "exhausted", person: null }, reveals };
    }
    if (next.body.status === "pending") {
      return { status: 200, body: { status: "pending", person: null }, reveals };
    }
    const revealed = await request(app)
      .post(`/orgs/audiences/${audienceId}/candidates/${next.body.candidate.candidateId}/reveal`)
      .set(headers)
      .send({});
    reveals += 1;
    if (revealed.status !== 200) return { status: revealed.status, body: revealed.body, reveals };
    if (revealed.body.status === "served") {
      return {
        status: 200,
        body: { status: "served", person: revealed.body.person, personId: revealed.body.personId },
        reveals,
      };
    }
    if (reveals >= maxReveals) throw new Error("serveApollo: too many not_served reveals");
  }
}
