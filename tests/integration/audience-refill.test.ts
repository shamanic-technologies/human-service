// The audience refill end to end against the real DB: low-pool detection on
// the brand's own numbers, the billing gate read from billing-service, and new
// ACTIVE audiences created through the split path (never an edited one).
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences, leadServes } from "../../src/db/schema.js";
import { ensureApolloPointer } from "../../src/services/audiences.js";
import { loadBrandPools, runAudienceRefillSweep } from "../../src/services/audience-refill.js";
import { draftAudienceTarget } from "../../src/services/audience-target.js";
import { ensureTargetText } from "../../src/services/audience-target-text.js";

// The person-level draft is pinned in tests/unit/audience-target.test.ts.
const WIDENED = "Owners, managers and site engineers at construction companies in Paraguay.";
vi.mock("../../src/services/audience-target.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-target.js")>()),
  draftAudienceTarget: vi.fn(),
}));

// The Apollo build is pinned by its own suites; here it must only be FIRED.
vi.mock("../../src/services/audiences.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audiences.js")>()),
  ensureApolloPointer: vi.fn(async (row: unknown) => row),
}));

// Each new audience's own text is drafted in the background; pinned by its own
// suite (audience-target-text), here it must only be FIRED.
vi.mock("../../src/services/audience-target-text.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-target-text.js")>()),
  ensureTargetText: vi.fn(async () => null),
}));

const app = createTestApp();

const ORG_PAYING = "a1000000-0000-4000-8000-000000000001";
const ORG_IDLE = "a1000000-0000-4000-8000-000000000002";
const ORG_HEALTHY = "a1000000-0000-4000-8000-000000000003";
const BRAND_PAYING = "b1000000-0000-4000-8000-000000000001";
const BRAND_IDLE = "b1000000-0000-4000-8000-000000000002";
const BRAND_HEALTHY = "b1000000-0000-4000-8000-000000000003";
const OFFER = "c1000000-0000-4000-8000-000000000001";
const USER = "d1000000-0000-4000-8000-000000000001";
const TARGET = "Owners and managers at construction companies in Paraguay.";

const BILLING: Record<string, string> = {
  [ORG_PAYING]: "will_charge",
  [ORG_IDLE]: "idle",
  [ORG_HEALTHY]: "will_charge",
};

const fetchSpy = vi.fn();
const fetchBefore = globalThis.fetch;

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function wire() {
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    const m = u.match(/by-org\/([^/]+)\/payment-outlook$/);
    if (m) {
      const state = BILLING[m[1]];
      return state ? json(200, { orgId: m[1], state }) : json(404, { error: "none" });
    }
    if (u.endsWith("/v1/runs")) return json(200, { id: "run-1" });
    const offers = u.match(/\/internal\/brands\/([^/]+)\/offers$/);
    if (offers) {
      return json(200, { offers: [{ offerId: OFFER, brandId: offers[1], name: "ObraCam", description: "Cameras for construction sites." }] });
    }
    if (u.includes("/v1/runs/")) return json(200, {});
    if (u.endsWith("/complete")) {
      return json(200, {
        json: {
          axes: ["seniority_role"],
          segments: [
            { name: "Site Engineers", description: "Site engineers at construction companies in Paraguay.", estimatedLeadCount: 400 },
            { name: "Up to 50 Employees", description: "Owners at small construction companies in Paraguay.", estimatedLeadCount: 300 },
          ],
        },
      });
    }
    if (u.endsWith("/orgs/judgments")) {
      const body = JSON.parse(init.body ?? "{}") as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((k) => [k, { type: "choice", choice: "globe-hemisphere-west", confidence: 0.9, probabilities: {} }])
      );
      return json(200, { model: "jev-latest", answers, usage: { inputTokens: 1, outputTokens: 0 } });
    }
    throw new Error("unexpected url " + u);
  });
}

async function seedBrand(orgId: string, brandId: string, opts: { apolloCount: number; served: number }) {
  // One exhausted audience (its whole reachable pool served) + `served` serves
  // on one recent day, so the pace is `served`/day.
  const [aud] = await db
    .insert(audiences)
    .values({
      orgId,
      brandId,
      offerId: OFFER,
      name: "Up to 50 Employees",
      description: "Owners at small construction companies in Paraguay.",
      nlPrompt: TARGET,
      provider: "apollo",
      apolloAudienceId: "apollo-1",
      filters: { q: "x" },
      apolloCount: opts.apolloCount,
      reachableCount: opts.apolloCount > 0 ? null : 0,
      status: "active",
      source: "split_proposal",
      createdByUserId: USER,
    })
    .returning();
  if (opts.served > 0) {
    await db.insert(leadServes).values(
      Array.from({ length: opts.served }, (_, i) => ({
        orgId,
        brandId,
        provider: "apollo",
        email: `p${i}@${brandId.slice(0, 4)}.test`,
        audienceId: aud.id,
        emailVerdict: "valid",
        servedAt: new Date(Date.now() - 2 * 86_400_000),
      }))
    );
  }
  return aud;
}

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  wire();
  vi.mocked(ensureApolloPointer).mockClear();
  vi.mocked(ensureTargetText).mockClear();
  vi.mocked(draftAudienceTarget).mockReset();
  vi.mocked(draftAudienceTarget).mockResolvedValue(WIDENED);
  process.env.BRAND_SERVICE_URL = "http://brand:8080";
  process.env.BRAND_SERVICE_API_KEY = "brand-key";
  process.env.BILLING_SERVICE_URL = "http://billing:8080";
  process.env.BILLING_SERVICE_API_KEY = "billing-key";
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  process.env.RUNS_SERVICE_URL = "http://runs:8080";
  process.env.RUNS_SERVICE_API_KEY = "runs-key";
  await cleanTestData();
});

afterAll(async () => {
  process.env.RUNS_SERVICE_URL = "";
  process.env.RUNS_SERVICE_API_KEY = "";
  globalThis.fetch = fetchBefore;
  await closeDb();
});

describe("low-pool detection", () => {
  it("flags a brand whose people left cover less than a week of its pace, not a healthy one", async () => {
    await seedBrand(ORG_PAYING, BRAND_PAYING, { apolloCount: 0, served: 23 });
    await seedBrand(ORG_HEALTHY, BRAND_HEALTHY, { apolloCount: 5000, served: 30 });
    const pools = await loadBrandPools();
    const paying = pools.find((p) => p.brandId === BRAND_PAYING)!;
    const healthy = pools.find((p) => p.brandId === BRAND_HEALTHY)!;
    expect(paying).toMatchObject({ remaining: 0, dailyPace: 23, low: true, unmeasurable: null });
    expect(healthy).toMatchObject({ remaining: 5000, low: false });
  });

  it("never measures an audience still waiting for its Apollo build as empty", async () => {
    await seedBrand(ORG_PAYING, BRAND_PAYING, { apolloCount: 0, served: 23 });
    await db.insert(audiences).values({
      orgId: ORG_PAYING,
      brandId: BRAND_PAYING,
      offerId: OFFER,
      name: "Pending",
      provider: "apollo",
      status: "active",
    });
    const [pool] = await loadBrandPools({ brandId: BRAND_PAYING });
    expect(pool).toMatchObject({ low: false, unmeasurable: "pointer_build_pending" });
  });
});

describe("refill sweep", () => {
  it("refills a low brand whose billing can charge it with NEW active audiences, and never one that cannot", async () => {
    const original = await seedBrand(ORG_PAYING, BRAND_PAYING, { apolloCount: 0, served: 23 });
    await seedBrand(ORG_IDLE, BRAND_IDLE, { apolloCount: 0, served: 10 });

    const res = await request(app).post("/internal/audience-refill").set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: false, low: 2, refilled: 1 });

    const paying = res.body.outcomes.find((o: { brandId: string }) => o.brandId === BRAND_PAYING);
    const idle = res.body.outcomes.find((o: { brandId: string }) => o.brandId === BRAND_IDLE);
    expect(paying).toMatchObject({ action: "refilled", billingState: "will_charge" });
    expect(idle).toMatchObject({ action: "skipped", reason: "not_chargeable", billingState: "idle" });

    // New rows: active, same offer + target, tagged auto_refill; a colliding
    // name is suffixed rather than reusing the existing audience.
    const rows = await db
      .select()
      .from(audiences)
      .where(and(eq(audiences.brandId, BRAND_PAYING), eq(audiences.source, "auto_refill")));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ status: "active", offerId: OFFER, nlPrompt: WIDENED, provider: "apollo", orgId: ORG_PAYING, createdByUserId: USER });
    }
    expect(rows.map((r) => r.name).sort()[1]).toMatch(/^Up to 50 Employees \w{3} \d{1,2}$/);

    // The original audience is untouched (immutable).
    const [same] = await db.select().from(audiences).where(eq(audiences.id, original.id));
    expect(same).toMatchObject({ name: original.name, filters: original.filters, status: "active" });

    // The idle org got nothing, not even an LLM call.
    const idleRows = await db.select().from(audiences).where(eq(audiences.brandId, BRAND_IDLE));
    expect(idleRows).toHaveLength(1);
    const completes = fetchSpy.mock.calls.filter(([u]) => String(u).endsWith("/complete"));
    expect(completes).toHaveLength(1);
    const prompt = JSON.parse(completes[0][1].body as string).message as string;
    expect(prompt).toContain(`ITS TARGET SO FAR: ${TARGET}`);
    expect(prompt).toContain("WHAT THIS COMPANY SELLS: ObraCam: Cameras for construction sites.");
    // The screen target is re-drafted from the old target + the new segments.
    expect(vi.mocked(draftAudienceTarget).mock.calls[0][0]).toMatchObject({
      brandId: BRAND_PAYING,
      offerId: OFFER,
      customerTarget: expect.stringContaining("- Site engineers at construction companies in Paraguay."),
    });
    expect(prompt).toContain("- Up to 50 Employees");

    // Each new audience's Apollo build is fired, org-billed.
    expect(vi.mocked(ensureApolloPointer)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ensureApolloPointer).mock.calls[0][1]).toEqual({ orgId: ORG_PAYING, userId: USER });
    // ... and so is each one's own text (two segments share one nl_prompt).
    expect(vi.mocked(ensureTargetText)).toHaveBeenCalledTimes(2);
    for (const r of rows) expect(r.targetText).toBeNull();

    // Cooldown: a second sweep does not refill the same brand again.
    const again = await runAudienceRefillSweep();
    expect(again!.refilled).toBe(0);
  });

  it("dry run reads billing but spends and writes nothing", async () => {
    await seedBrand(ORG_PAYING, BRAND_PAYING, { apolloCount: 0, served: 23 });
    const res = await request(app).post("/internal/audience-refill?dryRun=true").set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.outcomes[0]).toMatchObject({ action: "would_refill", billingState: "will_charge" });
    expect(fetchSpy.mock.calls.some(([u]) => String(u).endsWith("/complete"))).toBe(false);
    const rows = await db.select().from(audiences).where(eq(audiences.brandId, BRAND_PAYING));
    expect(rows).toHaveLength(1);
  });

  it("an org billing has no account for, or cannot read, gets nothing", async () => {
    const ORG_NONE = "a1000000-0000-4000-8000-000000000009";
    await seedBrand(ORG_NONE, BRAND_PAYING, { apolloCount: 0, served: 23 });
    const r1 = await runAudienceRefillSweep();
    expect(r1!.outcomes[0]).toMatchObject({ action: "skipped", reason: "not_chargeable", billingState: "no_account" });

    BILLING[ORG_NONE] = "will_charge";
    fetchSpy.mockImplementationOnce(async () => json(503, { error: "down" }));
    const r2 = await runAudienceRefillSweep();
    expect(r2!.outcomes[0]).toMatchObject({ action: "skipped", reason: "billing_unreadable" });
    delete BILLING[ORG_NONE];
    expect(fetchSpy.mock.calls.some(([u]) => String(u).endsWith("/complete"))).toBe(false);
  });
});
