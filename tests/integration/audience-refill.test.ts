// The audience refill end to end against the real DB: low-pool detection on
// the brand's own numbers, the billing gate read from billing-service, new
// ACTIVE audiences INSIDE the validated target through the split path (never an
// edited one), and, when nobody is left inside it, a widening PROPOSAL the
// client accepts or declines (never active audiences outside the target).
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences, audienceWideningProposals, leadServes } from "../../src/db/schema.js";
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

// What the split answers to each of the refill's two asks.
const INSIDE_SEGMENTS = [
  { name: "51-200 Employees", description: "Owners and managers at mid-size construction companies in Paraguay.", estimatedLeadCount: 200 },
  { name: "Up to 50 Employees", description: "Owners at small construction companies in Paraguay.", estimatedLeadCount: 300 },
];
const WIDE_SEGMENTS = [
  { name: "Site Engineers", description: "Site engineers at construction companies in Paraguay.", estimatedLeadCount: 400 },
  { name: "Architects", description: "Architects at architecture firms in Paraguay.", estimatedLeadCount: 250 },
];
let insideAnswer: unknown[] = INSIDE_SEGMENTS;
let wideAnswer: unknown[] = WIDE_SEGMENTS;

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
      const message = (JSON.parse(init.body ?? "{}") as { message: string }).message;
      const segments = message.includes("THE TARGET THE CLIENT VALIDATED") ? insideAnswer : wideAnswer;
      return json(200, { json: { axes: segments.length > 1 ? ["company_size"] : [], segments } });
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

function completePrompts(): string[] {
  return fetchSpy.mock.calls
    .filter(([u]) => String(u).endsWith("/complete"))
    .map(([, init]) => (JSON.parse(init.body as string) as { message: string }).message);
}

const orgHeaders = (orgId: string) => ({ ...getAuthHeaders(), "x-org-id": orgId });

beforeEach(async () => {
  insideAnswer = INSIDE_SEGMENTS;
  wideAnswer = WIDE_SEGMENTS;
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
  it("refills a low brand whose billing can charge it with NEW active audiences INSIDE its target, and never one that cannot", async () => {
    const original = await seedBrand(ORG_PAYING, BRAND_PAYING, { apolloCount: 0, served: 23 });
    await seedBrand(ORG_IDLE, BRAND_IDLE, { apolloCount: 0, served: 10 });

    const res = await request(app).post("/internal/audience-refill").set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: false, low: 2, refilled: 1, proposed: 0 });

    const paying = res.body.outcomes.find((o: { brandId: string }) => o.brandId === BRAND_PAYING);
    const idle = res.body.outcomes.find((o: { brandId: string }) => o.brandId === BRAND_IDLE);
    expect(paying).toMatchObject({ action: "refilled", billingState: "will_charge", proposal: null });
    expect(paying.created).toHaveLength(2);
    expect(idle).toMatchObject({ action: "skipped", reason: "not_chargeable", billingState: "idle" });

    // New rows: active, same offer, the VALIDATED target verbatim as the screen
    // target, tagged auto_refill; a colliding name is suffixed.
    const rows = await db
      .select()
      .from(audiences)
      .where(and(eq(audiences.brandId, BRAND_PAYING), eq(audiences.source, "auto_refill")));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ status: "active", offerId: OFFER, nlPrompt: TARGET, provider: "apollo", orgId: ORG_PAYING, createdByUserId: USER });
    }
    expect(rows.map((r) => r.name).sort()[1]).toMatch(/^Up to 50 Employees \w{3} \d{1,2}$/);
    // Nothing was widened: no re-drafted target, no proposal.
    expect(vi.mocked(draftAudienceTarget)).not.toHaveBeenCalled();
    expect(await db.select().from(audienceWideningProposals)).toHaveLength(0);

    // The original audience is untouched (immutable).
    const [same] = await db.select().from(audiences).where(eq(audiences.id, original.id));
    expect(same).toMatchObject({ name: original.name, filters: original.filters, status: "active", nlPrompt: TARGET });

    // The idle org got nothing, not even an LLM call. The paying one: ONE ask,
    // inside its validated target.
    const idleRows = await db.select().from(audiences).where(eq(audiences.brandId, BRAND_IDLE));
    expect(idleRows).toHaveLength(1);
    const prompts = completePrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`THE TARGET THE CLIENT VALIDATED: ${TARGET}`);
    expect(prompts[0]).toContain("WHAT THIS COMPANY SELLS: ObraCam: Cameras for construction sites.");
    expect(prompts[0]).toContain("- Up to 50 Employees");
    expect(prompts[0]).not.toContain("NEXT closest");

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

  it("a refill whose audiences were all archived or deprecated does not hold the cooldown; a paused one does", async () => {
    await seedBrand(ORG_PAYING, BRAND_PAYING, { apolloCount: 0, served: 23 });
    const rejected = (status: string, name: string) => ({
      orgId: ORG_PAYING,
      brandId: BRAND_PAYING,
      offerId: OFFER,
      name,
      description: "Athletic trainers in Paraguay.",
      nlPrompt: WIDENED,
      provider: "apollo",
      apolloAudienceId: `apollo-${name}`,
      filters: { q: name },
      apolloCount: 0,
      reachableCount: 0,
      status,
      source: "auto_refill",
      createdByUserId: USER,
      createdAt: new Date(Date.now() - 86_400_000),
    });
    await db.insert(audiences).values([rejected("archived", "Rejected A"), rejected("deprecated", "Rejected B")]);
    const r1 = await runAudienceRefillSweep({ brandId: BRAND_PAYING, dryRun: true });
    expect(r1!.outcomes[0]).toMatchObject({ action: "would_refill" });

    const [paused] = await db.insert(audiences).values(rejected("paused", "Paused C")).returning();
    const r2 = await runAudienceRefillSweep({ brandId: BRAND_PAYING, dryRun: true });
    expect(r2!.outcomes[0]).toMatchObject({ action: "skipped", reason: "cooldown" });
    expect(paused.status).toBe("paused");
  });

  it("reads the VALIDATED target, never the widened one an older refill wrote", async () => {
    await seedBrand(ORG_PAYING, BRAND_PAYING, { apolloCount: 0, served: 23 });
    // A pre-2026-10-04 refill row: newer, active, carrying a target the refill
    // widened on its own. Old enough to be outside the cooldown.
    await db.insert(audiences).values({
      orgId: ORG_PAYING,
      brandId: BRAND_PAYING,
      offerId: OFFER,
      name: "Athletic Trainers",
      description: "Athletic trainers in Paraguay.",
      nlPrompt: WIDENED,
      provider: "apollo",
      apolloAudienceId: "apollo-2",
      filters: { q: "y" },
      apolloCount: 0,
      reachableCount: 0,
      status: "active",
      source: "auto_refill",
      createdByUserId: USER,
      createdAt: new Date(Date.now() - 5 * 86_400_000),
    });
    const r = await runAudienceRefillSweep();
    expect(r!.outcomes[0]).toMatchObject({ action: "refilled" });
    expect(completePrompts()[0]).toContain(`THE TARGET THE CLIENT VALIDATED: ${TARGET}`);
    const fresh = await db
      .select()
      .from(audiences)
      .where(and(eq(audiences.brandId, BRAND_PAYING), eq(audiences.source, "auto_refill")));
    expect(fresh.filter((a) => a.nlPrompt === TARGET)).toHaveLength(2);
  });
});

describe("nobody left inside the target: a widening PROPOSAL, never active audiences", () => {
  async function propose() {
    insideAnswer = [];
    const original = await seedBrand(ORG_PAYING, BRAND_PAYING, { apolloCount: 0, served: 23 });
    const res = await request(app).post("/internal/audience-refill").set(getAuthHeaders());
    expect(res.status).toBe(200);
    return { original, res };
  }

  it("creates zero audiences and stores a pending proposal a consumer can read", async () => {
    const { original, res } = await propose();
    expect(res.body).toMatchObject({ refilled: 0, proposed: 1 });
    const outcome = res.body.outcomes[0];
    expect(outcome).toMatchObject({ action: "widening_proposed", reason: null, created: [] });
    expect(outcome.proposal).toMatchObject({
      status: "pending",
      brandId: BRAND_PAYING,
      offerId: OFFER,
      baseTarget: TARGET,
      widenedTarget: WIDENED,
      createdAudienceIds: [],
    });
    expect(outcome.proposal.segments.map((s: { name: string }) => s.name)).toEqual(["Site Engineers", "Architects"]);

    // Nothing created, the existing audience and its screen target untouched.
    const rows = await db.select().from(audiences).where(eq(audiences.brandId, BRAND_PAYING));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: original.id, nlPrompt: TARGET, status: "active" });
    expect(vi.mocked(ensureApolloPointer)).not.toHaveBeenCalled();

    // Two asks: inside the target first, then the next closest buyers.
    const prompts = completePrompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("THE TARGET THE CLIENT VALIDATED");
    expect(prompts[1]).toContain("NEXT closest");

    // A consumer reads it.
    const list = await request(app)
      .get(`/orgs/audiences/widening-proposals?brandId=${BRAND_PAYING}&status=pending`)
      .set(orgHeaders(ORG_PAYING));
    expect(list.status).toBe(200);
    expect(list.body.proposals).toHaveLength(1);
    expect(list.body.proposals[0].id).toBe(outcome.proposal.id);
    const one = await request(app)
      .get(`/orgs/audiences/widening-proposals/${outcome.proposal.id}`)
      .set(orgHeaders(ORG_PAYING));
    expect(one.body.proposal).toMatchObject({ id: outcome.proposal.id, status: "pending" });
    // Another org cannot.
    const foreign = await request(app)
      .get(`/orgs/audiences/widening-proposals/${outcome.proposal.id}`)
      .set(orgHeaders(ORG_IDLE));
    expect(foreign.status).toBe(404);

    // The next sweep (cooldown aside) answers the same pending proposal, free.
    fetchSpy.mockClear();
    const again = await runAudienceRefillSweep({ brandId: BRAND_PAYING });
    expect(again!.outcomes[0]).toMatchObject({ action: "widening_proposed" });
    expect(again!.outcomes[0].proposal!.id).toBe(outcome.proposal.id);
    expect(completePrompts()).toHaveLength(0);
    // Dry run too.
    const dry = await runAudienceRefillSweep({ brandId: BRAND_PAYING, dryRun: true });
    expect(dry!.outcomes[0]).toMatchObject({ action: "widening_proposed" });
  });

  it("accept creates the proposed audiences ACTIVE on the wider target, idempotently", async () => {
    const { original, res } = await propose();
    const id = res.body.outcomes[0].proposal.id as string;

    const a1 = await request(app)
      .post(`/orgs/audiences/widening-proposals/${id}/accept`)
      .set({ ...orgHeaders(ORG_PAYING), "x-user-id": USER });
    expect(a1.status).toBe(200);
    expect(a1.body.proposal).toMatchObject({ status: "accepted" });
    expect(a1.body.audiences).toHaveLength(2);
    expect(a1.body.proposal.createdAudienceIds).toEqual(a1.body.audiences.map((a: { id: string }) => a.id));

    const created = await db
      .select()
      .from(audiences)
      .where(and(eq(audiences.brandId, BRAND_PAYING), eq(audiences.source, "widening_accepted")));
    expect(created).toHaveLength(2);
    for (const r of created) {
      expect(r).toMatchObject({ status: "active", offerId: OFFER, nlPrompt: WIDENED, createdByUserId: USER });
    }
    expect(vi.mocked(ensureApolloPointer)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ensureTargetText)).toHaveBeenCalledTimes(2);
    const [same] = await db.select().from(audiences).where(eq(audiences.id, original.id));
    expect(same).toMatchObject({ nlPrompt: TARGET, status: "active" });

    // Repeat: same audiences, nothing new.
    const a2 = await request(app)
      .post(`/orgs/audiences/widening-proposals/${id}/accept`)
      .set(orgHeaders(ORG_PAYING));
    expect(a2.status).toBe(200);
    expect(a2.body.audiences.map((a: { id: string }) => a.id)).toEqual(a1.body.audiences.map((a: { id: string }) => a.id));
    const all = await db.select().from(audiences).where(eq(audiences.brandId, BRAND_PAYING));
    expect(all).toHaveLength(3);

    // Declining an accepted proposal is a conflict.
    const d = await request(app)
      .post(`/orgs/audiences/widening-proposals/${id}/decline`)
      .set(orgHeaders(ORG_PAYING));
    expect(d.status).toBe(409);
  });

  it("decline changes nothing, is idempotent, and is never re-proposed for the same target", async () => {
    const { res } = await propose();
    const id = res.body.outcomes[0].proposal.id as string;

    const d1 = await request(app)
      .post(`/orgs/audiences/widening-proposals/${id}/decline`)
      .set(orgHeaders(ORG_PAYING));
    expect(d1.status).toBe(200);
    expect(d1.body.proposal).toMatchObject({ status: "declined", createdAudienceIds: [] });
    const d2 = await request(app)
      .post(`/orgs/audiences/widening-proposals/${id}/decline`)
      .set(orgHeaders(ORG_PAYING));
    expect(d2.status).toBe(200);
    expect(d2.body.proposal.decidedAt).toBe(d1.body.proposal.decidedAt);
    const acc = await request(app)
      .post(`/orgs/audiences/widening-proposals/${id}/accept`)
      .set(orgHeaders(ORG_PAYING));
    expect(acc.status).toBe(409);
    expect(await db.select().from(audiences).where(eq(audiences.brandId, BRAND_PAYING))).toHaveLength(1);

    // Inside the cooldown: skipped.
    const r1 = await runAudienceRefillSweep({ brandId: BRAND_PAYING });
    expect(r1!.outcomes[0]).toMatchObject({ action: "skipped", reason: "cooldown" });
    // Past it: still nobody inside, and the client said no to widening.
    await db
      .update(audienceWideningProposals)
      .set({ createdAt: new Date(Date.now() - 5 * 86_400_000) })
      .where(eq(audienceWideningProposals.id, id));
    fetchSpy.mockClear();
    const r2 = await runAudienceRefillSweep({ brandId: BRAND_PAYING });
    expect(r2!.outcomes[0]).toMatchObject({ action: "skipped", reason: "widening_declined", proposal: null });
    const prompts = completePrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("THE TARGET THE CLIENT VALIDATED");
    expect(await db.select().from(audienceWideningProposals)).toHaveLength(1);
  });

  it("nobody inside and nobody close outside: skipped nothing_left, nothing stored", async () => {
    wideAnswer = [];
    insideAnswer = [];
    await seedBrand(ORG_PAYING, BRAND_PAYING, { apolloCount: 0, served: 23 });
    const r = await runAudienceRefillSweep();
    expect(r!.outcomes[0]).toMatchObject({ action: "skipped", reason: "nothing_left", proposal: null, created: [] });
    expect(await db.select().from(audienceWideningProposals)).toHaveLength(0);
    expect(await db.select().from(audiences).where(eq(audiences.brandId, BRAND_PAYING))).toHaveLength(1);
  });

  it("an unknown proposal id is a 404", async () => {
    const r = await request(app)
      .post("/orgs/audiences/widening-proposals/e1000000-0000-4000-8000-000000000001/accept")
      .set(orgHeaders(ORG_PAYING));
    expect(r.status).toBe(404);
  });
});

describe("refill guards", () => {
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
