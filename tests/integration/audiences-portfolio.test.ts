// The launch-time ICP audience portfolio: the cold split (adopted when a
// pre-payment flow already confirmed it) = the client PROFILES, plus per profile
// one buying-signal list per signal reaching 20+ companies FOR THAT PROFILE, all
// ACTIVE. The cold rows share ONE nl_prompt; a signal list screens on its
// profile's own text (profile-sources.ts).
// Idempotent per (org, brand, offer). The LLM / Apollo calls are mocked at
// their client modules; their own suites pin them.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { ensureTargetText } from "../../src/services/audience-target-text.js";
import { draftAudienceTarget } from "../../src/services/audience-target.js";
import { proposeAudienceSplit } from "../../src/services/audience-split.js";
import { settlePortfolioBackground } from "../../src/services/audience-portfolio.js";
import {
  createApolloSignalAudience,
  measureSignalCoverage,
} from "../../src/lib/apollo-audiences.js";
import { ProviderError } from "../../src/services/people-providers.js";
import { ChatServiceError } from "../../src/lib/chat-client.js";

vi.mock("../../src/services/audience-target.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-target.js")>()),
  draftAudienceTarget: vi.fn(),
}));
vi.mock("../../src/services/audience-split.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-split.js")>()),
  proposeAudienceSplit: vi.fn(),
}));
vi.mock("../../src/lib/apollo-audiences.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/apollo-audiences.js")>()),
  suggestApolloAudience: vi.fn(),
  measureSignalCoverage: vi.fn(),
  createApolloSignalAudience: vi.fn(),
}));
// The background Apollo build of each cold row has its own suite: here it lands a
// pointer named after the profile, so the signal lists are built on it.
vi.mock("../../src/services/audiences.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audiences.js")>()),
  ensureApolloPointer: vi.fn(async (row: { name: string; apolloAudienceId: string | null }) => ({
    ...row,
    apolloAudienceId: row.apolloAudienceId ?? `apollo-${row.name}`,
  })),
}));
// Each profile's own text (segment drafting has its own suite).
vi.mock("../../src/services/audience-target-text.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-target-text.js")>()),
  ensureTargetText: vi.fn(),
}));

const app = createTestApp();
const ORG = "00000000-0000-0000-0000-000000000001";
const BRAND = "00000000-0000-4000-8000-0000000000b1";
const OFFER = "00000000-0000-4000-8000-0000000000c1";
const ICP = "Founders of B2B SaaS companies in the US and Europe";
const DRAFTED = "Founders and CEOs of B2B SaaS companies in the US and Europe, plus their chiefs of staff. Not HR.";

function launch(body: Record<string, unknown> = {}) {
  return request(app)
    .post("/orgs/audiences/portfolio")
    .set(getAuthHeaders())
    .send({ brandId: BRAND, offerId: OFFER, targetAudience: ICP, ...body });
}

// First call (answers with the cold set, status building), wait for the
// background signal phase, then read the finished portfolio back.
async function launched(body: Record<string, unknown> = {}) {
  const first = await launch(body);
  expect(first.status).toBe(200);
  await settlePortfolioBackground();
  const done = await launch(body);
  expect(done.body.status).toBe("ready");
  return done;
}

function coverage(companies: { hiring: number; job_change: number; funding: number }) {
  return {
    baseCount: 50_000,
    signals: (["hiring", "job_change", "funding"] as const).flatMap((type) =>
      [30, 90].map((windowDays) => ({
        type,
        windowDays,
        count: companies[type] * 3,
        companies: companies[type],
        companiesExact: true,
      }))
    ),
  };
}

beforeEach(async () => {
  vi.mocked(draftAudienceTarget).mockReset().mockResolvedValue(DRAFTED);
  vi.mocked(proposeAudienceSplit).mockReset().mockResolvedValue({
    axes: ["geography"],
    segments: [
      { name: "US SaaS founders", description: "Founders of B2B SaaS companies in the US.", icon: "x", iconConfidence: 1, estimatedLeadCount: null },
      { name: "Europe SaaS founders", description: "Founders of B2B SaaS companies in Europe.", icon: "y", iconConfidence: 1, estimatedLeadCount: null },
    ],
  });
  vi.mocked(ensureTargetText).mockReset().mockImplementation(async (row) => row.targetText ?? `Own text of ${row.name}`);
  vi.mocked(measureSignalCoverage).mockReset().mockResolvedValue(coverage({ hiring: 300, job_change: 120, funding: 7 }));
  vi.mocked(createApolloSignalAudience).mockReset().mockImplementation(async (a) => ({
    apolloAudienceId: `${a.baseApolloAudienceId}/${a.type}`,
    filters: { person_titles: ["founder"], buying_signal: { type: a.type, window_days: a.windowDays } },
    count: 900,
  }));
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

describe("POST /orgs/audiences/portfolio", () => {
  it("answers with the cold set at once (building), then the signals land in the background", async () => {
    const first = await launch();
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("building");
    expect(first.body.replayed).toBe(false);
    expect(first.body.audiences.map((a: { kind: string }) => a.kind)).toEqual(["cold", "cold"]);
    expect(first.body.signals).toEqual([]);
    for (const a of first.body.audiences) expect(a.status).toBe("active");
    await settlePortfolioBackground();
    const done = await launch();
    expect(done.body.status).toBe("ready");
    expect(done.body.replayed).toBe(true);
    expect(done.body.audiences).toHaveLength(6);
  });

  it("creates the cold split (the profiles) + per profile a signal list per signal reaching 20+ companies FOR THAT PROFILE", async () => {
    const res = await launched();
    expect(res.status).toBe(200);
    expect(res.body.target).toBe(DRAFTED);

    const kinds = res.body.audiences.map((a: { name: string; kind: string }) => `${a.kind}:${a.name}`);
    expect(kinds).toEqual([
      "cold:US SaaS founders",
      "cold:Europe SaaS founders",
      "signal:US SaaS founders (Hiring now)",
      "signal:US SaaS founders (New in role)",
      "signal:Europe SaaS founders (Hiring now)",
      "signal:Europe SaaS founders (New in role)",
    ]);
    const [us, eu] = res.body.audiences;
    for (const a of res.body.audiences) {
      expect(a.status).toBe("active");
      expect(a.offerId).toBe(OFFER);
      expect(a.brandId).toBe(BRAND);
    }
    // The profiles share the split's target; each signal list screens on ITS profile's own text.
    expect(us.nlPrompt).toBe(DRAFTED);
    expect(us.profileAudienceId).toBeNull();
    const hiring = res.body.audiences.find((a: { name: string }) => a.name === "US SaaS founders (Hiring now)");
    expect(hiring.profileAudienceId).toBe(us.id);
    expect(hiring.nlPrompt).toBe("Own text of US SaaS founders");
    expect(hiring.targetText).toBe("Own text of US SaaS founders");
    expect(hiring.signal).toEqual({ type: "hiring", windowDays: 30 });
    expect(hiring.provider).toBe("apollo");
    expect(hiring.apolloAudienceId).toBe("apollo-US SaaS founders/hiring");
    expect(hiring.filters.buying_signal).toEqual({ type: "hiring", window_days: 30 });
    const euList = res.body.audiences.find((a: { name: string }) => a.name === "Europe SaaS founders (New in role)");
    expect(euList.profileAudienceId).toBe(eu.id);

    // funding reaches 7 companies (< 20) per profile: absent, its shortfall reported per profile.
    const funding = res.body.signals.filter((s: { type: string }) => s.type === "funding");
    expect(funding).toHaveLength(2);
    for (const f of funding) expect(f).toMatchObject({ outcome: "below_threshold", companies: 7, windowDays: 90, audienceId: null });
    expect(funding.map((f: { profileAudienceId: string }) => f.profileAudienceId).sort()).toEqual([us.id, eu.id].sort());

    // Each signal measured on the PROFILE's Apollo audience; no whole-ICP build any more.
    const measuredOn = vi.mocked(measureSignalCoverage).mock.calls.map((c) => c[0].apolloAudienceId).sort();
    expect(measuredOn).toEqual(["apollo-Europe SaaS founders", "apollo-US SaaS founders"]);
    expect(vi.mocked(measureSignalCoverage).mock.calls[0][0].windowDays).toEqual([30, 90]);
  });

  it("a replay returns the same set and creates nothing new", async () => {
    const first = await launched();
    const before = await db.select().from(audiences);
    const second = await launch();
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.portfolioId).toBe(first.body.portfolioId);
    expect(second.body.audiences.map((a: { id: string }) => a.id)).toEqual(
      first.body.audiences.map((a: { id: string }) => a.id)
    );
    expect(second.body.signals).toEqual(first.body.signals);
    expect(await db.select().from(audiences)).toHaveLength(before.length);
    expect(proposeAudienceSplit).toHaveBeenCalledTimes(1);
    expect(createApolloSignalAudience).toHaveBeenCalledTimes(4);
  });

  it("two concurrent calls run ONE launch", async () => {
    const [a, b] = await Promise.all([launch(), launch()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.portfolioId).toBe(b.body.portfolioId);
    await settlePortfolioBackground();
    expect(proposeAudienceSplit).toHaveBeenCalledTimes(1);
    expect(await db.select().from(audiences)).toHaveLength(6);
  });

  it("ADOPTS the split a pre-payment flow already confirmed (suggested), activates it, never re-splits", async () => {
    const shared = "Founders of SaaS companies, plus their assistants.";
    const pre = await db
      .insert(audiences)
      .values(
        ["US SaaS founders", "Europe SaaS founders", "Asia SaaS founders"].map((name) => ({
          orgId: ORG,
          brandId: BRAND,
          offerId: OFFER,
          name,
          description: `${name}.`,
          nlPrompt: shared,
          provider: "apollo",
          status: "suggested",
          source: "split_proposal",
        }))
      )
      .returning();
    const res = await launched();
    expect(res.status).toBe(200);
    expect(proposeAudienceSplit).not.toHaveBeenCalled();
    expect(draftAudienceTarget).not.toHaveBeenCalled();
    const cold = res.body.audiences.filter((a: { kind: string }) => a.kind === "cold");
    expect(cold.map((a: { id: string }) => a.id).sort()).toEqual(pre.map((p) => p.id).sort());
    for (const a of res.body.audiences) expect(a.status).toBe("active");
    for (const a of cold) expect(a.nlPrompt).toBe(shared);
    expect(cold.every((a: { adopted: boolean }) => a.adopted)).toBe(true);
    // 3 adopted profiles x (hiring, job_change) above threshold.
    expect(res.body.audiences.filter((a: { kind: string }) => a.kind === "signal")).toHaveLength(6);
  });

  it("adopted rows that disagree on nl_prompt are all given ONE fresh draft", async () => {
    await db.insert(audiences).values(
      ["A seg", "B seg"].map((name, i) => ({
        orgId: ORG,
        brandId: BRAND,
        offerId: OFFER,
        name,
        nlPrompt: i === 0 ? "one" : null,
        provider: "apollo",
        status: "suggested",
        source: "split_proposal",
      }))
    );
    const res = await launched();
    expect(res.status).toBe(200);
    for (const a of res.body.audiences.filter((x: { kind: string }) => x.kind === "cold")) expect(a.nlPrompt).toBe(DRAFTED);
  });

  it("an adopted one-segment row holding the whole target as its text gets its own segment text once it is one of several", async () => {
    const shared = "Heads of QA and CTOs at B2B software companies.";
    const [alone] = await db
      .insert(audiences)
      .values([
        { orgId: ORG, brandId: BRAND, offerId: OFFER, name: "Heads of QA", description: "Heads of QA at B2B software companies.", nlPrompt: shared, targetText: shared, targetTextOrigin: "audience_target", provider: "apollo", status: "active", source: "split_proposal" },
        { orgId: ORG, brandId: BRAND, offerId: OFFER, name: "CTOs", description: "CTOs at B2B software companies.", nlPrompt: shared, targetText: "CTOs (also titled ...)", targetTextOrigin: "segment_target", provider: "apollo", status: "suggested", source: "split_proposal" },
      ])
      .returning();
    await launched();
    const [row] = await db.select().from(audiences).where(eq(audiences.id, alone.id));
    // Cleared, so its own segment text is drafted (ensureTargetText); never the whole target.
    expect(row.targetText).toBeNull();
    const call = vi.mocked(ensureTargetText).mock.calls.find((c) => c[0].id === alone.id);
    expect(call?.[0].targetText).toBeNull();
  });

  it("a failed coverage read skips every signal (recorded) but the cold audiences still ship", async () => {
    vi.mocked(measureSignalCoverage).mockRejectedValue(new ProviderError("apollo", 500, "boom"));
    const res = await launched();
    expect(res.status).toBe(200);
    expect(res.body.audiences.map((a: { kind: string }) => a.kind)).toEqual(["cold", "cold"]);
    expect(res.body.signals.map((s: { outcome: string }) => s.outcome)).toEqual(Array(6).fill("failed"));
    expect(res.body.signals[0].reason).toContain("boom");
  });

  it("one signal's creation failing does not stop the others", async () => {
    vi.mocked(createApolloSignalAudience).mockImplementation(async (a) => {
      if (a.type === "hiring") throw new ProviderError("apollo", 400, "conflict");
      return { apolloAudienceId: `${a.baseApolloAudienceId}/${a.type}`, filters: { buying_signal: { type: a.type } }, count: 10 };
    });
    const res = await launched();
    expect(res.status).toBe(200);
    const outcomes = res.body.signals.map((s: { profileName: string; type: string; outcome: string }) => `${s.profileName}/${s.type}:${s.outcome}`);
    expect(outcomes.sort()).toEqual([
      "Europe SaaS founders/funding:below_threshold",
      "Europe SaaS founders/hiring:failed",
      "Europe SaaS founders/job_change:created",
      "US SaaS founders/funding:below_threshold",
      "US SaaS founders/hiring:failed",
      "US SaaS founders/job_change:created",
    ]);
  });

  it("a failed cold split fails the call loud (502), creates nothing, and a retry launches again", async () => {
    vi.mocked(proposeAudienceSplit).mockRejectedValueOnce(new ChatServiceError(502, "LLM down"));
    const res = await launch();
    expect(res.status).toBe(502);
    expect(await db.select().from(audiences)).toHaveLength(0);
    const retry = await launched();
    expect(retry.status).toBe(200);
    expect(retry.body.audiences).toHaveLength(6);
  });

  it("a cold segment name already taken in the offer gets a date suffix, never a 409", async () => {
    await db.insert(audiences).values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      name: "US SaaS founders",
      provider: "apollo",
      status: "archived",
      source: "auto_refill",
    });
    const res = await launched();
    expect(res.status).toBe(200);
    const names = res.body.audiences.map((a: { name: string }) => a.name);
    expect(names[0]).toMatch(/^US SaaS founders \w+ \d+$/);
    const rows = await db
      .select()
      .from(audiences)
      .where(and(eq(audiences.brandId, BRAND), eq(audiences.status, "active")));
    expect(rows).toHaveLength(6);
  });

  it("400 on a missing ICP text", async () => {
    const res = await launch({ targetAudience: "" });
    expect(res.status).toBe(400);
  });
});
