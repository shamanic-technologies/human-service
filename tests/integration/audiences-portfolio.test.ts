// The launch-time ICP audience portfolio: the cold split (adopted when a
// pre-payment flow already confirmed it) plus one buying-signal audience per
// signal reaching 20+ companies, all ACTIVE, all carrying ONE nl_prompt.
// Idempotent per (org, brand, offer). The LLM / Apollo calls are mocked at
// their client modules; their own suites pin them.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { draftAudienceTarget } from "../../src/services/audience-target.js";
import { proposeAudienceSplit } from "../../src/services/audience-split.js";
import { settlePortfolioBackground } from "../../src/services/audience-portfolio.js";
import {
  createApolloSignalAudience,
  measureSignalCoverage,
  suggestApolloAudience,
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
// The background Apollo build of each cold row has its own suite.
vi.mock("../../src/services/audiences.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audiences.js")>()),
  ensureApolloPointer: vi.fn(async (row: unknown) => row),
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
  vi.mocked(suggestApolloAudience).mockReset().mockResolvedValue({
    apolloAudienceId: "11111111-0000-4000-8000-000000000001",
    filters: { person_titles: ["founder"] },
    count: 40_000,
    status: null,
    degraded: false,
    candidates: [
      { apolloAudienceId: "11111111-0000-4000-8000-000000000001", filters: { person_titles: ["founder"] }, count: 40_000, sample: [], notes: null },
    ],
  });
  vi.mocked(measureSignalCoverage).mockReset().mockResolvedValue(coverage({ hiring: 300, job_change: 120, funding: 7 }));
  vi.mocked(createApolloSignalAudience).mockReset().mockImplementation(async (a) => ({
    apolloAudienceId: a.type === "hiring" ? "22222222-0000-4000-8000-000000000001" : "22222222-0000-4000-8000-000000000002",
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
    expect(done.body.audiences).toHaveLength(4);
  });

  it("creates the cold split + a signal audience per signal reaching 20+ companies, all ACTIVE with ONE nl_prompt", async () => {
    const res = await launched();
    expect(res.status).toBe(200);
    expect(res.body.target).toBe(DRAFTED);

    const kinds = res.body.audiences.map((a: { name: string; kind: string }) => `${a.kind}:${a.name}`);
    expect(kinds).toEqual([
      "cold:US SaaS founders",
      "cold:Europe SaaS founders",
      "signal:Hiring now",
      "signal:New in role",
    ]);
    for (const a of res.body.audiences) {
      expect(a.status).toBe("active");
      expect(a.nlPrompt).toBe(DRAFTED);
      expect(a.offerId).toBe(OFFER);
      expect(a.brandId).toBe(BRAND);
    }
    const hiring = res.body.audiences.find((a: { name: string }) => a.name === "Hiring now");
    expect(hiring.signal).toEqual({ type: "hiring", windowDays: 30 });
    expect(hiring.provider).toBe("apollo");
    expect(hiring.apolloAudienceId).toBe("22222222-0000-4000-8000-000000000001");
    expect(hiring.filters.buying_signal).toEqual({ type: "hiring", window_days: 30 });

    // funding reaches 7 companies (< 20): absent, its shortfall reported.
    const funding = res.body.signals.find((s: { type: string }) => s.type === "funding");
    expect(funding).toMatchObject({ outcome: "below_threshold", companies: 7, windowDays: 90, audienceId: null });
    expect(res.body.audiences.some((a: { signal: { type: string } | null }) => a.signal?.type === "funding")).toBe(false);

    // Signals measured on the WHOLE ICP's apollo audience, in the windows used.
    expect(vi.mocked(measureSignalCoverage).mock.calls[0][0]).toMatchObject({
      apolloAudienceId: "11111111-0000-4000-8000-000000000001",
      windowDays: [30, 90],
    });
    expect(vi.mocked(suggestApolloAudience).mock.calls[0][0]).toMatchObject({ description: ICP, brandId: BRAND });
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
    expect(suggestApolloAudience).toHaveBeenCalledTimes(1);
    expect(createApolloSignalAudience).toHaveBeenCalledTimes(2);
  });

  it("two concurrent calls run ONE launch", async () => {
    const [a, b] = await Promise.all([launch(), launch()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.portfolioId).toBe(b.body.portfolioId);
    await settlePortfolioBackground();
    expect(proposeAudienceSplit).toHaveBeenCalledTimes(1);
    expect(await db.select().from(audiences)).toHaveLength(4);
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
    for (const a of res.body.audiences) {
      expect(a.status).toBe("active");
      expect(a.nlPrompt).toBe(shared);
    }
    expect(cold.every((a: { adopted: boolean }) => a.adopted)).toBe(true);
    expect(res.body.audiences.filter((a: { kind: string }) => a.kind === "signal")).toHaveLength(2);
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
    for (const a of res.body.audiences) expect(a.nlPrompt).toBe(DRAFTED);
  });

  it("a failed coverage read skips every signal (recorded) but the cold audiences still ship", async () => {
    vi.mocked(measureSignalCoverage).mockRejectedValue(new ProviderError("apollo", 500, "boom"));
    const res = await launched();
    expect(res.status).toBe(200);
    expect(res.body.audiences.map((a: { kind: string }) => a.kind)).toEqual(["cold", "cold"]);
    expect(res.body.signals.map((s: { outcome: string }) => s.outcome)).toEqual(["failed", "failed", "failed"]);
    expect(res.body.signals[0].reason).toContain("coverage read failed");
  });

  it("a failed ICP build skips the signals, cold still ships", async () => {
    vi.mocked(suggestApolloAudience).mockRejectedValue(new ProviderError("apollo", 504, "timeout"));
    const res = await launched();
    expect(res.status).toBe(200);
    expect(res.body.audiences).toHaveLength(2);
    expect(res.body.signals.every((s: { outcome: string }) => s.outcome === "failed")).toBe(true);
    expect(measureSignalCoverage).not.toHaveBeenCalled();
  });

  it("one signal's creation failing does not stop the others", async () => {
    vi.mocked(createApolloSignalAudience).mockImplementation(async (a) => {
      if (a.type === "hiring") throw new ProviderError("apollo", 400, "conflict");
      return { apolloAudienceId: "22222222-0000-4000-8000-000000000002", filters: { buying_signal: { type: a.type } }, count: 10 };
    });
    const res = await launched();
    expect(res.status).toBe(200);
    const outcomes = Object.fromEntries(res.body.signals.map((s: { type: string; outcome: string }) => [s.type, s.outcome]));
    expect(outcomes).toEqual({ hiring: "failed", job_change: "created", funding: "below_threshold" });
  });

  it("a failed cold split fails the call loud (502), creates nothing, and a retry launches again", async () => {
    vi.mocked(proposeAudienceSplit).mockRejectedValueOnce(new ChatServiceError(502, "LLM down"));
    const res = await launch();
    expect(res.status).toBe(502);
    expect(await db.select().from(audiences)).toHaveLength(0);
    const retry = await launched();
    expect(retry.status).toBe(200);
    expect(retry.body.audiences).toHaveLength(4);
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
    expect(rows).toHaveLength(4);
  });

  it("400 on a missing ICP text", async () => {
    const res = await launch({ targetAudience: "" });
    expect(res.status).toBe(400);
  });
});
