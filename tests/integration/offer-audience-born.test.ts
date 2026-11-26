import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../../src/lib/email-verification.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, readEmailVerification: () => ({ verdict: "valid", deliverable: true }) };
});
vi.mock("../../src/lib/lead-won.js", () => ({
  listWonEmails: vi.fn(async () => []),
  isEmailWon: vi.fn(async () => false),
  WonLeadsSourceError: class WonLeadsSourceError extends Error {},
  WonLeadsConfigError: class WonLeadsConfigError extends Error {},
}));
vi.mock("../../src/services/bounces.js", () => ({
  filterBounced: vi.fn(async (_identity: unknown, items: unknown[]) => items),
  isEmailBounced: vi.fn(async () => false),
}));
vi.mock("../../src/lib/instantly-optouts.js", () => ({
  listStandingOptOutEmails: vi.fn(async () => []),
  isEmailOptedOut: vi.fn(async () => false),
  OptOutSourceError: class OptOutSourceError extends Error {},
  OptOutConfigError: class OptOutConfigError extends Error {},
}));

import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences, offerAudienceRealignments } from "../../src/db/schema.js";
import { confirmAudienceSplit } from "../../src/services/audience-split.js";
import { OFFER_AUDIENCE_ALIGN_REASON, OFFER_AUDIENCE_BORN_REASON } from "../../src/services/offer-audiences.js";

// ONBOARDING-ONE-AUDIENCE-1126: every NEW offer is born on ONE audience (role target, the confirmed text), the
// lists it found are brand searches; the sweep aligns every offer still on the old model, reversibly.

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000c2";
const OFFER = "00000000-0000-4000-8000-0000000000a2";
const ORG = getAuthHeaders()["x-org-id"];
const g = globalThis as { __offerName?: string | null };

const fetchSpy = vi.fn();
const fetchBefore = globalThis.fetch;

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  delete g.__offerName;
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  await cleanTestData();
});

afterAll(async () => {
  delete g.__offerName;
  globalThis.fetch = fetchBefore;
  await closeDb();
});

const offerRows = () =>
  db.select().from(audiences).where(and(eq(audiences.brandId, BRAND), eq(audiences.offerId, OFFER)));

const confirm = (segments: string[], targetAudience: string | null = "Agency founders who sell voice work") =>
  confirmAudienceSplit({
    orgId: ORG,
    userId: null,
    brandId: BRAND,
    offerId: OFFER,
    targetAudience,
    segments: segments.map((name) => ({ name, description: `${name} in the US` })),
  });

describe("an offer is born on ONE audience", () => {
  it("a split confirm creates the offer's target and makes the segments brand lists; a second confirm adds lists only", async () => {
    const created = await confirm(["Agency Founders", "Studio Owners"]);
    expect(created.map((r) => r.role)).toEqual(["search", "search"]);

    let rows = await offerRows();
    const target = rows.filter((r) => r.role === "target");
    expect(target).toHaveLength(1);
    expect(target[0]).toMatchObject({
      name: "Test offer",
      nlPrompt: "Agency founders who sell voice work",
      targetText: "Agency founders who sell voice work",
      status: "active",
      provider: "apollo",
    });
    expect(rows.filter((r) => r.role === "search")).toHaveLength(2);

    await confirm(["Freelance Producers"]);
    rows = await offerRows();
    expect(rows.filter((r) => r.role === "target")).toHaveLength(1);
    expect(rows.filter((r) => r.role === "search")).toHaveLength(3);

    // The customer's list shows the offer's one audience; the lists only when asked.
    const list = await request(app).get(`/orgs/audiences?brandId=${BRAND}&offerId=${OFFER}`).set(getAuthHeaders());
    expect(list.body.audiences.map((a: { id: string }) => a.id)).toEqual([target[0].id]);

    const ledger = await db.select().from(offerAudienceRealignments).where(eq(offerAudienceRealignments.reason, OFFER_AUDIENCE_BORN_REASON));
    expect(ledger.map((l) => l.action).sort()).toEqual(["made_search", "made_search", "made_search", "target_created"]);
  });

  it("no target text or an offer brand-service does not know ⟹ rows as before, no target", async () => {
    await confirm(["Agency Founders"], null);
    g.__offerName = null;
    await confirm(["Studio Owners"]);
    const rows = await offerRows();
    expect(rows.map((r) => r.role)).toEqual([null, null]);
  });

  it("a row already named after the offer: the target takes another name", async () => {
    await confirm(["Test offer"], null);
    await confirm(["Studio Owners"]);
    const target = (await offerRows()).find((r) => r.role === "target")!;
    expect(target.name).toBe("Test offer audience");
    expect((await offerRows()).every((r) => r.role !== null)).toBe(true);
  });
});

describe("the align sweep — offers still on the old model", () => {
  async function createOld(name: string, status?: "suggested" | "paused") {
    const res = await request(app)
      .post("/orgs/audiences")
      .set(getAuthHeaders())
      .send({
        name,
        brandId: BRAND,
        offerId: OFFER,
        provider: "apollo",
        filters: { person_titles: ["Founder"] },
        apolloAudienceId: `apollo-${name}`,
        nlPrompt: "Founders of US agencies",
        apolloCount: 100,
      });
    expect(res.status).toBe(201);
    const id = res.body.audience.id as string;
    if (status) await db.update(audiences).set({ status }).where(eq(audiences.id, id));
    return id;
  }

  it("dry run writes nothing; the run creates the target and turns live rows into lists; revert undoes it; the target serves", async () => {
    const live = await createOld("Agency Founders");
    const paused = await createOld("Studio Owners", "paused");
    const suggested = await createOld("Unchosen", "suggested");

    const dry = await request(app).post("/internal/offer-audiences/align?dryRun=true").set(getAuthHeaders());
    expect(dry.status).toBe(200);
    expect(dry.body.offers).toBe(1);
    expect(dry.body.aligned[0]).toMatchObject({ target: "would_create", targetId: null });
    expect(dry.body.aligned[0].madeSearch.sort()).toEqual([live, paused].sort());
    expect((await offerRows()).every((r) => r.role === null)).toBe(true);

    const run = await request(app).post("/internal/offer-audiences/align").set(getAuthHeaders());
    expect(run.body.aligned[0].target).toBe("created");
    const rows = await offerRows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(live)!.role).toBe("search");
    expect(byId.get(paused)!.role).toBe("search");
    expect(byId.get(suggested)!.role).toBeNull();
    const target = rows.find((r) => r.role === "target")!;
    expect(target).toMatchObject({ name: "Test offer", targetText: "Founders of US agencies" });

    // Nothing left to align.
    const again = await request(app).post("/internal/offer-audiences/align").set(getAuthHeaders());
    expect(again.body.offers).toBe(0);

    // The target walks the brand list: a candidate, nothing paid.
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/search/next")) {
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({
            people: [
              {
                id: "p1",
                firstName: "Ana",
                title: "Founder",
                seniority: "founder",
                linkedinUrl: "linkedin.com/in/p1",
                organizationName: "Voice Studio",
                organizationDomain: "voicestudio.example",
                country: "United States",
              },
            ],
            done: false,
          }),
        };
      }
      throw new Error("unexpected url " + url);
    });
    const next = await request(app).post(`/orgs/audiences/${target.id}/candidates/next`).set(getAuthHeaders());
    expect(next.status).toBe(200);
    expect(next.body.status).toBe("candidate");
    expect(next.body.candidate.providerPersonId).toBe("p1");

    const rev = await request(app)
      .post("/internal/offer-audiences/realign/revert")
      .set(getAuthHeaders())
      .send({ reason: OFFER_AUDIENCE_ALIGN_REASON });
    expect(rev.body).toEqual({ restoredSearches: 2, deprecatedTargets: 1 });
    const after = await offerRows();
    expect(after.filter((r) => r.id !== target.id).every((r) => r.role === null)).toBe(true);
  });

  it("an offer brand-service does not know is skipped, never guessed", async () => {
    await createOld("Agency Founders");
    g.__offerName = null;
    const run = await request(app).post("/internal/offer-audiences/align").set(getAuthHeaders());
    expect(run.body.skipped).toEqual([{ orgId: ORG, brandId: BRAND, offerId: OFFER, reason: "offer_not_found" }]);
    expect((await offerRows()).every((r) => r.role === null)).toBe(true);
  });
});
