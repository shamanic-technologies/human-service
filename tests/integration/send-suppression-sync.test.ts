import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { brandSuppressions, suppressionSendSyncState } from "../../src/db/schema.js";
import { isEmailSuppressed, recordServe } from "../../src/services/suppression.js";
import { collectSends } from "../../src/services/send-suppression-sync.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

// RECONTACT-LOOP-1011 (Perky, 2026-10-11): a person SERVED on 07-01 and EMAILED
// on 07-16 was re-servable from 10-01, while instantly-service refuses the send
// until 10-16. The window must run from the send.

const ORG = "91e76989-71ba-420d-ba73-bb3961430aa7";
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const OTHER_BRAND = "a179bbd9-8eed-4dba-9338-78125922b0c6";

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

type Fact = { seq: string; type: string; occurredAt: string; leadEmail: string; orgId: string | null; brandIds: string[] };
const sent = (seq: number, email: string, at: Date, over: Partial<Fact> = {}): Fact => ({
  seq: String(seq),
  type: "email_sent",
  occurredAt: at.toISOString(),
  leadEmail: email,
  orgId: ORG,
  brandIds: [BRAND],
  ...over,
});

// The feed, as instantly-service serves it: facts after `since`, in seq order.
let feed: Fact[] = [];
const fetchBefore = globalThis.fetch;
const feedCalls: string[] = [];

beforeEach(async () => {
  await cleanTestData();
  feed = [];
  feedCalls.length = 0;
  process.env.INSTANTLY_SERVICE_URL = "http://instantly.test";
  process.env.INSTANTLY_SERVICE_API_KEY = "k";
  vi.stubGlobal("fetch", async (url: string) => {
    feedCalls.push(url);
    const since = Number(new URL(url).searchParams.get("since") ?? "0");
    const limit = Number(new URL(url).searchParams.get("limit"));
    const after = feed.filter((f) => Number(f.seq) > since);
    const facts = after.slice(0, limit);
    return new Response(
      JSON.stringify({
        facts,
        nextCursor: facts.length ? facts[facts.length - 1].seq : String(since),
        hasMore: after.length > limit,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
});

afterAll(async () => {
  globalThis.fetch = fetchBefore;
  await closeDb();
});

const app = createTestApp();
const sync = () => request(app).post("/internal/sync-send-suppressions").set(getAuthHeaders());
const row = async (email: string, brandId = BRAND) =>
  (
    await db
      .select()
      .from(brandSuppressions)
      .where(and(eq(brandSuppressions.orgId, ORG), eq(brandSuppressions.brandId, brandId), eq(brandSuppressions.emailNorm, email)))
  )[0];

describe("send → suppression sync", () => {
  it("re-anchors a lapsed serve window on the later real send (the Perky case)", async () => {
    await recordServe(ORG, [BRAND], [
      { email: "zach@midatlanticspinalrehab.com", linkedinUrl: null, firstName: "Zach", lastName: null, companyDomain: null, provider: "apollo", providerPersonId: "p1" },
    ]);
    // Served 102 days ago: outside the 3-month window.
    await db.update(brandSuppressions).set({ firstServedAt: daysAgo(102), lastServedAt: daysAgo(102) });
    expect(await isEmailSuppressed(ORG, [BRAND], "zach@midatlanticspinalrehab.com")).toBe(false);

    // Emailed 87 days ago.
    feed = [sent(10, "Zach@MidAtlanticSpinalRehab.com", daysAgo(87))];
    const res = await sync();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sends: 1, applied: 1, created: 0, toCursor: "10" });

    const r = await row("zach@midatlanticspinalrehab.com");
    expect(Math.abs(r.lastSentAt!.getTime() - daysAgo(87).getTime())).toBeLessThan(5_000);
    expect(Math.abs(r.lastServedAt.getTime() - daysAgo(87).getTime())).toBeLessThan(5_000);
    expect(r.providerPersonId).toBe("p1");
    expect(await isEmailSuppressed(ORG, [BRAND], "zach@midatlanticspinalrehab.com")).toBe(true);
  });

  it("never moves a window back: a send older than the last serve leaves it", async () => {
    await recordServe(ORG, [BRAND], [
      { email: "a@x.com", linkedinUrl: null, firstName: null, lastName: null, companyDomain: null, provider: "apollo", providerPersonId: null },
    ]);
    const before = (await row("a@x.com")).lastServedAt;
    feed = [sent(1, "a@x.com", daysAgo(20))];
    await sync();
    const r = await row("a@x.com");
    expect(r.lastServedAt.getTime()).toBe(before.getTime());
    expect(Math.abs(r.lastSentAt!.getTime() - daysAgo(20).getTime())).toBeLessThan(5_000);
  });

  it("creates a row for a person emailed for the brand but never served here, per atomic brand", async () => {
    feed = [sent(1, "b@x.com", daysAgo(10), { brandIds: [BRAND, OTHER_BRAND] })];
    const res = await sync();
    expect(res.body).toMatchObject({ applied: 2, created: 2 });
    expect(await isEmailSuppressed(ORG, [BRAND], "b@x.com")).toBe(true);
    expect(await isEmailSuppressed(ORG, [OTHER_BRAND], "b@x.com")).toBe(true);
    expect((await row("b@x.com")).lastProvider).toBeNull();
  });

  it("skips sends outside the window, non-send facts and unattributed sends; advances the cursor", async () => {
    feed = [
      sent(1, "old@x.com", daysAgo(120)),
      { ...sent(2, "open@x.com", daysAgo(1)), type: "email_opened" },
      sent(3, "noorg@x.com", daysAgo(1), { orgId: null }),
      sent(4, "nobrand@x.com", daysAgo(1), { brandIds: [] }),
    ];
    const res = await sync();
    expect(res.body).toMatchObject({ facts: 4, sends: 3, applied: 0, skippedOutsideWindow: 1, skippedUnattributed: 2, toCursor: "4" });
    expect(await db.select().from(brandSuppressions)).toHaveLength(0);
    const [state] = await db.select().from(suppressionSendSyncState);
    expect(state.cursor).toBe(4);
  });

  it("resumes from the stored cursor and pages through the feed", async () => {
    feed = Array.from({ length: 1500 }, (_, i) => sent(i + 1, `p${i}@x.com`, daysAgo(5)));
    const first = await sync();
    expect(first.body).toMatchObject({ pages: 2, applied: 1500, toCursor: "1500", hasMore: false });

    feed.push(sent(1501, "late@x.com", daysAgo(1)));
    feedCalls.length = 0;
    const second = await sync();
    expect(second.body).toMatchObject({ fromCursor: "1500", applied: 1, toCursor: "1501" });
    expect(feedCalls[0]).toContain("since=1500");
  });

  it("fails loud (502) when the feed cannot be read, and keeps the cursor", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    const res = await sync();
    expect(res.status).toBe(502);
    expect(await db.select().from(suppressionSendSyncState)).toHaveLength(0);
  });
});

describe("collectSends", () => {
  it("keeps the latest send per (org, brand, email)", () => {
    const cutoff = daysAgo(90);
    const out = collectSends([sent(1, "a@x.com", daysAgo(30)), sent(2, "A@x.com ", daysAgo(10))], cutoff);
    expect(out.keys).toHaveLength(1);
    expect(Math.abs(out.keys[0].sentAt.getTime() - daysAgo(10).getTime())).toBeLessThan(5_000);
  });
});
