// ONE text per audience (audiences.target_text): who the customer wants for
// THIS audience, shown as the audience and judged against by the pre-pay screen.
// Siblings of a split share nl_prompt, so each gets its own segment target; an
// audience that is not one of several has its nl_prompt as its text. Every read
// also lists the channel list(s) derived from the text, each with its size.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import {
  draftAudienceTarget,
  draftSegmentTarget,
  draftSegmentTargetOnPlatform,
  offersForSegment,
} from "../../src/services/audience-target.js";
import { ensureTargetText } from "../../src/services/audience-target-text.js";

vi.mock("../../src/services/audience-target.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-target.js")>()),
  draftAudienceTarget: vi.fn(),
  draftSegmentTarget: vi.fn(),
  draftSegmentTargetOnPlatform: vi.fn(),
  offersForSegment: vi.fn(async () => []),
}));

const app = createTestApp();
const ORG = "00000000-0000-4000-8000-0000000000a1";
const BRAND = "00000000-0000-4000-8000-0000000000b1";
const OFFER = "00000000-0000-4000-8000-0000000000c1";
const SHARED =
  "Managing Partners, Solo Practitioners and Legal Administrators at US immigration law firms, plus their assistants.";
const identity = { orgId: ORG, userId: "00000000-0000-4000-8000-0000000000d1", runId: "r1" };

const fetchSpy = vi.fn();
const fetchBefore = globalThis.fetch;

function headers() {
  return { ...getAuthHeaders(), "x-org-id": ORG };
}

async function seed(values: Partial<typeof audiences.$inferInsert> & { name: string }) {
  const [row] = await db
    .insert(audiences)
    .values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      provider: "apollo",
      status: "active",
      ...values,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  vi.mocked(draftAudienceTarget).mockReset();
  vi.mocked(draftSegmentTarget).mockReset();
  vi.mocked(draftSegmentTargetOnPlatform).mockReset();
  vi.mocked(draftSegmentTarget).mockImplementation(
    async (a) => `TEXT FOR ${a.segment.name}`
  );
  vi.mocked(draftSegmentTargetOnPlatform).mockImplementation(
    async (a) => `PLATFORM TEXT FOR ${a.segment.name}`
  );
  await cleanTestData();
});

afterAll(async () => {
  globalThis.fetch = fetchBefore;
  await closeDb();
});

describe("ensureTargetText — the one rule", () => {
  it("an audience among several sharing nl_prompt gets its OWN segment target, drafted from the shared target + its segment", async () => {
    const mp = await seed({ name: "Managing Partners", nlPrompt: SHARED, description: "Managing Partners at US immigration law firms." });
    await seed({ name: "Solo Practitioners", nlPrompt: SHARED, description: "Solo Practitioners running US immigration law firms." });

    const text = await ensureTargetText(mp, identity);

    expect(text).toBe("TEXT FOR Managing Partners");
    expect(vi.mocked(draftSegmentTarget).mock.calls[0][0]).toMatchObject({
      sharedTarget: SHARED,
      segment: { name: "Managing Partners", description: "Managing Partners at US immigration law firms." },
      brandId: BRAND,
      offerId: OFFER,
    });
    const [row] = await db.select().from(audiences).where(eq(audiences.id, mp.id));
    expect(row).toMatchObject({ targetText: "TEXT FOR Managing Partners", targetTextOrigin: "segment_target" });
  });

  it("an audience NOT one of several has its nl_prompt as its text, no LLM call", async () => {
    const solo = await seed({ name: "Only one", nlPrompt: SHARED, description: "Some sentence." });
    expect(await ensureTargetText(solo, identity)).toBe(SHARED);
    expect(draftSegmentTarget).not.toHaveBeenCalled();
    const [row] = await db.select().from(audiences).where(eq(audiences.id, solo.id));
    expect(row.targetTextOrigin).toBe("audience_target");
  });

  it("a buying-signal / linkedin_engagement audience is screened against the WHOLE target, even beside siblings", async () => {
    await seed({ name: "Managing Partners", nlPrompt: SHARED, description: "Managing Partners." });
    const sig = await seed({
      name: "Engaged with competitor posts",
      nlPrompt: SHARED,
      description: "People who reacted to a competitor's LinkedIn post.",
      filters: { buying_signal: { type: "linkedin_engagement", window_days: 30, competitor_pages: ["x"] } },
    });
    expect(await ensureTargetText(sig, identity)).toBe(SHARED);
    expect(draftSegmentTarget).not.toHaveBeenCalled();
  });

  it("never replaces a text already written", async () => {
    const row = await seed({ name: "A", nlPrompt: SHARED, targetText: "kept", targetTextOrigin: "segment_target" });
    expect(await ensureTargetText(row, identity)).toBe("kept");
    expect(draftSegmentTarget).not.toHaveBeenCalled();
  });
});

describe("split confirm writes the text", () => {
  it("one segment: the drafted target IS its text at creation; several: each drafts its own in the background", async () => {
    vi.mocked(draftAudienceTarget).mockResolvedValue(SHARED);
    const one = await request(app)
      .post("/orgs/audiences/split/confirm")
      .set(headers())
      .send({ brandId: BRAND, offerId: OFFER, targetAudience: "immigration lawyers", segments: [{ name: "All", description: "Immigration lawyers." }] });
    expect(one.status).toBe(201);
    expect(one.body.audiences[0]).toMatchObject({ targetText: SHARED, targetTextOrigin: "audience_target", targetTextMissingReason: null });

    await cleanTestData();
    const two = await request(app)
      .post("/orgs/audiences/split/confirm")
      .set(headers())
      .send({
        brandId: BRAND,
        offerId: OFFER,
        targetAudience: "immigration lawyers",
        segments: [
          { name: "Managing Partners", description: "Managing Partners at immigration firms." },
          { name: "Solo Practitioners", description: "Solo Practitioners at immigration firms." },
        ],
      });
    expect(two.status).toBe(201);
    for (const a of two.body.audiences) {
      expect(a).toMatchObject({ targetText: null, targetTextMissingReason: "not_written_yet" });
    }
    await vi.waitFor(async () => {
      const rows = await db.select().from(audiences);
      expect(rows.map((r) => r.targetText).sort()).toEqual([
        "TEXT FOR Managing Partners",
        "TEXT FOR Solo Practitioners",
      ]);
    });
  });
});

describe("reads: text + channels", () => {
  it("list and get serve targetText and one channel per list, sized like sizeCount", async () => {
    const plain = await seed({ name: "Plain", nlPrompt: SHARED, targetText: "own", targetTextOrigin: "segment_target", apolloAudienceId: "ap-1", filters: { q: 1 }, apolloCount: 120 });
    await seed({ name: "Hiring", nlPrompt: SHARED, apolloAudienceId: "ap-2", filters: { buying_signal: { type: "hiring", window_days: 30 } }, apolloCount: 40 });
    await seed({ name: "Engagers", nlPrompt: SHARED, apolloAudienceId: "ap-3", filters: { buying_signal: { type: "linkedin_engagement", window_days: 30, competitor_pages: ["p"] } } });
    await seed({ name: "Unbuilt", nlPrompt: SHARED });
    await seed({ name: "No text", nlPrompt: null, provider: null });

    const res = await request(app).get(`/orgs/audiences?brandId=${BRAND}&limit=50`).set(headers());
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.audiences.map((a: { name: string }) => [a.name, a]));

    expect(by.Plain).toMatchObject({ targetText: "own", targetTextOrigin: "segment_target", sizeCount: 120 });
    expect(by.Plain.channels).toEqual([
      { channel: "cold_email", list: "apollo_search", audienceId: plain.id, signal: null, size: 120, sizeUnknownReason: null },
    ]);
    expect(by.Hiring.channels[0]).toMatchObject({ list: "apollo_buying_signal", signal: { type: "hiring", windowDays: 30 }, size: 40 });
    expect(by.Engagers.channels[0]).toMatchObject({ list: "linkedin_engagement", size: null, sizeUnknownReason: "unknown_until_walked" });
    expect(by.Unbuilt.channels[0]).toMatchObject({ list: "apollo_search", size: null, sizeUnknownReason: "not_built_yet" });
    expect(by.Unbuilt).toMatchObject({ targetText: null, targetTextMissingReason: "not_written_yet" });
    expect(by["No text"]).toMatchObject({ targetText: null, targetTextMissingReason: "no_customer_text", channels: [] });

    const one = await request(app).get(`/orgs/audiences/${plain.id}`).set(headers());
    expect(one.body.audience.channels[0].size).toBe(120);
  });

  it("PATCH nlPrompt carries an audience_target text along, never a segment target", async () => {
    const a = await seed({ name: "A", nlPrompt: "old", targetText: "old", targetTextOrigin: "audience_target" });
    const b = await seed({ name: "B", nlPrompt: "old", targetText: "segment", targetTextOrigin: "segment_target" });
    await request(app).patch(`/orgs/audiences/${a.id}`).set(headers()).send({ nlPrompt: "new" });
    await request(app).patch(`/orgs/audiences/${b.id}`).set(headers()).send({ nlPrompt: "new" });
    const rows = Object.fromEntries((await db.select().from(audiences)).map((r) => [r.name, r]));
    expect(rows.A).toMatchObject({ nlPrompt: "new", targetText: "new", targetTextOrigin: "audience_target" });
    expect(rows.B).toMatchObject({ nlPrompt: "new", targetText: "segment", targetTextOrigin: "segment_target" });
  });
});

describe("POST /internal/backfill-audience-target-texts", () => {
  it("dry-run classifies and writes nothing; real run writes each rule, platform-billed; re-run is a no-op", async () => {
    await seed({ name: "MP", nlPrompt: SHARED, description: "Managing Partners." });
    await seed({ name: "Solo", nlPrompt: SHARED, description: "Solo Practitioners." });
    await seed({ name: "Alone", nlPrompt: "just me", description: "x" });
    await seed({ name: "Nothing", nlPrompt: null });
    await seed({ name: "Retired", nlPrompt: SHARED, description: "x", status: "deprecated" });

    const dry = await request(app).post("/internal/backfill-audience-target-texts?dryRun=true").set(getAuthHeaders());
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, scanned: 4, audienceTarget: 1, segmentTarget: 2, noCustomerText: 1, failed: [] });
    expect(draftSegmentTargetOnPlatform).not.toHaveBeenCalled();
    expect((await db.select().from(audiences)).every((r) => r.targetText === null)).toBe(true);

    const real = await request(app).post("/internal/backfill-audience-target-texts").set(getAuthHeaders());
    expect(real.body).toMatchObject({ dryRun: false, audienceTarget: 1, segmentTarget: 2, noCustomerText: 1 });
    expect(offersForSegment).toHaveBeenCalled();
    expect(draftSegmentTarget).not.toHaveBeenCalled();
    const rows = Object.fromEntries((await db.select().from(audiences)).map((r) => [r.name, r]));
    expect(rows.MP).toMatchObject({ targetText: "PLATFORM TEXT FOR MP", targetTextOrigin: "segment_target" });
    expect(rows.Alone).toMatchObject({ targetText: "just me", targetTextOrigin: "audience_target" });
    expect(rows.Nothing.targetText).toBeNull();
    expect(rows.Retired.targetText).toBeNull();

    const again = await request(app).post("/internal/backfill-audience-target-texts").set(getAuthHeaders());
    expect(again.body).toMatchObject({ scanned: 1, audienceTarget: 0, segmentTarget: 0, noCustomerText: 1 });
  });
});
