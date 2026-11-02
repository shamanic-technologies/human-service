// HIRING-TITLES-1102 (2026-11-02): a hiring source can say WHICH roles are being
// hired. apollo-service owns the criterion (signal.jobTitles); this suite pins
// what human-service forwards, stores and shows, and that without titles
// nothing changes.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences, audienceSources, audienceTeaserBuffer } from "../../src/db/schema.js";
import { createApolloAudienceFromFilters, createApolloSignalAudience, measureSignalCoverage } from "../../src/lib/apollo-audiences.js";
import { getPaymentOutlook } from "../../src/lib/billing-outlook.js";

vi.mock("../../src/lib/apollo-audiences.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/apollo-audiences.js")>()),
  measureSignalCoverage: vi.fn(),
  createApolloSignalAudience: vi.fn(),
  createApolloAudienceFromFilters: vi.fn(),
}));
vi.mock("../../src/services/audiences.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audiences.js")>()),
  ensureApolloPointer: vi.fn(async (row: unknown) => row),
}));
vi.mock("../../src/services/audience-target-text.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/audience-target-text.js")>()),
  ensureTargetText: vi.fn(async (row: { targetText: string | null; nlPrompt: string | null }) => row.targetText ?? row.nlPrompt),
}));
vi.mock("../../src/lib/billing-outlook.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/billing-outlook.js")>()),
  getPaymentOutlook: vi.fn(),
}));
vi.mock("../../src/services/runs.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/runs.js")>()),
  createRun: vi.fn(async () => "00000000-0000-4000-8000-00000000aaaa"),
  completeRun: vi.fn(async () => undefined),
}));

const app = createTestApp();
const ORG = getAuthHeaders()["x-org-id"];
const USER = getAuthHeaders()["x-user-id"];
const BRAND = "00000000-0000-4000-8000-0000000001b1";
const OFFER = "00000000-0000-4000-8000-0000000001c1";
const TITLES = ["QA", "Test Automation", "SDET", "Quality Engineering"];
const SIGNALS = "sourcing-apollo-buying-signals";

async function insertProfile(name: string) {
  const [row] = await db
    .insert(audiences)
    .values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      name,
      nlPrompt: "Heads of QA at software companies.",
      targetText: "Heads of QA at software companies.",
      provider: "apollo",
      apolloAudienceId: `99999999-0000-4000-8000-00000000000${name.length % 10}`,
      filters: { person_titles: ["head of qa"] } as never,
      status: "active",
      createdByUserId: USER,
    })
    .returning();
  return row;
}

async function insertSource(audienceId: string, signalType: string, filters: Record<string, unknown>) {
  const [row] = await db
    .insert(audienceSources)
    .values({
      orgId: ORG,
      brandId: BRAND,
      offerId: OFFER,
      audienceId,
      list: "apollo_buying_signal",
      signalType,
      windowDays: 30,
      name: "Hiring now",
      apolloAudienceId: "old-apollo-audience",
      filters,
      apolloCount: 900,
      reachableCount: 400,
      exhaustedAt: new Date(),
      status: "active",
    })
    .returning();
  return row;
}

function sourceChannel(body: { audience: { channels: Array<{ sourceId?: string; signal: unknown }> } }, sourceId: string) {
  return body.audience.channels.find((c) => c.sourceId === sourceId);
}

beforeEach(async () => {
  vi.mocked(measureSignalCoverage).mockReset().mockResolvedValue({
    baseCount: 5000,
    signals: (["hiring", "job_change", "funding"] as const).flatMap((type) =>
      [30, 90].map((windowDays) => ({ type, windowDays, count: 300, companies: type === "funding" ? 4 : 80, companiesExact: true }))
    ),
  });
  vi.mocked(createApolloSignalAudience).mockReset().mockImplementation(async (a) => ({
    apolloAudienceId: `new-${a.type}-${a.jobTitles?.length ?? 0}`,
    filters: {
      person_titles: ["head of qa"],
      buying_signal: { type: a.type, window_days: a.windowDays, ...(a.jobTitles?.length ? { job_titles: a.jobTitles } : {}) },
    },
    count: 120,
  }));
  vi.mocked(createApolloAudienceFromFilters).mockReset().mockResolvedValue({
    apolloAudienceId: "native-record-1",
    count: 777,
  } as never);
  vi.mocked(getPaymentOutlook).mockReset().mockResolvedValue({ orgId: ORG, state: "will_charge" } as never);
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

describe("PATCH /orgs/audiences/:id/sources/:sourceId (job titles)", () => {
  it("rebuilds the hiring source with the titles, drops its queued teasers, shows them on the channel", async () => {
    const profile = await insertProfile("Heads of QA");
    const source = await insertSource(profile.id, "hiring", { person_titles: ["head of qa"], buying_signal: { type: "hiring", window_days: 30 } });
    await db.insert(audienceTeaserBuffer).values([
      { orgId: ORG, audienceId: profile.id, sourceId: source.id, providerPersonId: "p-old" },
      { orgId: ORG, audienceId: profile.id, sourceId: null, providerPersonId: "p-own" },
    ] as never);

    const res = await request(app)
      .patch(`/orgs/audiences/${profile.id}/sources/${source.id}`)
      .set(getAuthHeaders())
      .send({ jobTitles: [...TITLES, " qa "] });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(vi.mocked(createApolloSignalAudience)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createApolloSignalAudience).mock.calls[0][0];
    expect(call).toMatchObject({ baseApolloAudienceId: profile.apolloAudienceId, type: "hiring", windowDays: 30, jobTitles: TITLES });

    const [after] = await db.select().from(audienceSources).where(eq(audienceSources.id, source.id));
    expect(after.apolloAudienceId).toBe("new-hiring-4");
    expect((after.filters as { buying_signal: { job_titles: string[] } }).buying_signal.job_titles).toEqual(TITLES);
    expect(after.apolloCount).toBe(120);
    expect(after.reachableCount).toBeNull();
    expect(after.exhaustedAt).toBeNull();
    expect(after.status).toBe("active");

    const buffer = await db.select().from(audienceTeaserBuffer);
    expect(buffer.map((b) => b.providerPersonId)).toEqual(["p-own"]);

    expect(sourceChannel(res.body, source.id)?.signal).toEqual({ type: "hiring", windowDays: 30, jobTitles: TITLES });
  });

  it("same titles again rebuild nothing; null on an untitled source changes nothing (any role, as before)", async () => {
    const profile = await insertProfile("Heads of QA");
    const source = await insertSource(profile.id, "hiring", { buying_signal: { type: "hiring", window_days: 30 } });
    const res = await request(app)
      .patch(`/orgs/audiences/${profile.id}/sources/${source.id}`)
      .set(getAuthHeaders())
      .send({ jobTitles: null });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(vi.mocked(createApolloSignalAudience)).not.toHaveBeenCalled();
    expect(sourceChannel(res.body, source.id)?.signal).toEqual({ type: "hiring", windowDays: 30, jobTitles: null });
  });

  it("clearing the titles rebuilds the source for any role (no jobTitles sent)", async () => {
    const profile = await insertProfile("Heads of QA");
    const source = await insertSource(profile.id, "hiring", { buying_signal: { type: "hiring", window_days: 30, job_titles: ["QA"] } });
    const res = await request(app)
      .patch(`/orgs/audiences/${profile.id}/sources/${source.id}`)
      .set(getAuthHeaders())
      .send({ jobTitles: [] });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(vi.mocked(createApolloSignalAudience).mock.calls[0][0].jobTitles).toBeNull();
  });

  it("a non-hiring source is a 400; an unknown source a 404", async () => {
    const profile = await insertProfile("Heads of QA");
    const funding = await insertSource(profile.id, "funding", { buying_signal: { type: "funding", window_days: 90 } });
    const bad = await request(app)
      .patch(`/orgs/audiences/${profile.id}/sources/${funding.id}`)
      .set(getAuthHeaders())
      .send({ jobTitles: ["QA"] });
    expect(bad.status).toBe(400);
    expect(bad.body.reason).toBe("not_a_hiring_source");
    const missing = await request(app)
      .patch(`/orgs/audiences/${profile.id}/sources/00000000-0000-4000-8000-0000000009ff`)
      .set(getAuthHeaders())
      .send({ jobTitles: ["QA"] });
    expect(missing.status).toBe(404);
  });
});

describe("POST /orgs/audiences/:id/sources", () => {
  it("adds a titled hiring source to a profile; a second one is a 409 naming the first", async () => {
    const profile = await insertProfile("Heads of QA");
    const res = await request(app)
      .post(`/orgs/audiences/${profile.id}/sources`)
      .set(getAuthHeaders())
      .send({ type: "hiring", jobTitles: TITLES });
    expect(res.status).toBe(201);
    expect(vi.mocked(createApolloSignalAudience).mock.calls[0][0]).toMatchObject({ type: "hiring", windowDays: 30, jobTitles: TITLES });
    expect(sourceChannel(res.body, res.body.sourceId)?.signal).toEqual({ type: "hiring", windowDays: 30, jobTitles: TITLES });
    const [stored] = await db.select().from(audienceSources).where(eq(audienceSources.id, res.body.sourceId));
    expect(stored.audienceId).toBe(profile.id);
    expect(stored.signalType).toBe("hiring");

    const again = await request(app)
      .post(`/orgs/audiences/${profile.id}/sources`)
      .set(getAuthHeaders())
      .send({ type: "hiring", jobTitles: ["SDET"] });
    expect(again.status).toBe(409);
    expect(again.body.sourceId).toBe(res.body.sourceId);
  });

  it("a profile stated in raw Apollo filters (no apollo-service record) gets one from its filters, then the source on it", async () => {
    const profile = await insertProfile("Heads of QA");
    await db.update(audiences).set({ apolloAudienceId: null }).where(eq(audiences.id, profile.id));
    const res = await request(app)
      .post(`/orgs/audiences/${profile.id}/sources`)
      .set(getAuthHeaders())
      .send({ type: "hiring", jobTitles: TITLES });
    expect(res.status).toBe(201);
    expect(vi.mocked(createApolloAudienceFromFilters).mock.calls[0][0]).toMatchObject({ filters: { person_titles: ["head of qa"] } });
    expect(vi.mocked(createApolloSignalAudience).mock.calls[0][0].baseApolloAudienceId).toBe("native-record-1");
    const [row] = await db.select().from(audiences).where(eq(audiences.id, profile.id));
    expect(row.apolloAudienceId).toBe("native-record-1");
  });

  it("jobTitles on a non-hiring signal is a 400, nothing built", async () => {
    const profile = await insertProfile("Heads of QA");
    const res = await request(app)
      .post(`/orgs/audiences/${profile.id}/sources`)
      .set(getAuthHeaders())
      .send({ type: "funding", jobTitles: ["QA"] });
    expect(res.status).toBe(400);
    expect(vi.mocked(createApolloSignalAudience)).not.toHaveBeenCalled();
  });
});

describe("automatic hiring sources inherit the offer's titles", () => {
  function signalsOn() {
    return request(app)
      .post("/orgs/source-campaigns/state")
      .set(getAuthHeaders())
      .send({ brandId: BRAND, offerId: OFFER, campaignId: "11111111-1111-4111-8111-111111111111", originSlug: SIGNALS, status: "on" });
  }

  it("without titles anywhere: measured and built for any role (unchanged)", async () => {
    await insertProfile("Heads of QA");
    const res = await signalsOn();
    expect(res.status).toBe(200);
    expect(vi.mocked(measureSignalCoverage).mock.calls[0][0].jobTitles).toBeNull();
    const hiring = vi.mocked(createApolloSignalAudience).mock.calls.find((c) => c[0].type === "hiring");
    expect(hiring?.[0].jobTitles).toBeNull();
  });

  it("a profile born later gets a hiring source with the titles a sibling's carries", async () => {
    const first = await insertProfile("Heads of QA");
    await insertSource(first.id, "hiring", { buying_signal: { type: "hiring", window_days: 30, job_titles: TITLES } });
    await insertSource(first.id, "job_change", { buying_signal: { type: "job_change", window_days: 90 } });
    const second = await insertProfile("VPs of Engineering");
    const res = await signalsOn();
    expect(res.status).toBe(200);
    const measured = vi.mocked(measureSignalCoverage).mock.calls.find((c) => c[0].apolloAudienceId === second.apolloAudienceId);
    expect(measured?.[0].jobTitles).toEqual(TITLES);
    const hiring = vi.mocked(createApolloSignalAudience).mock.calls.filter((c) => c[0].type === "hiring");
    expect(hiring).toHaveLength(1);
    expect(hiring[0][0].jobTitles).toEqual(TITLES);
    const jobChange = vi.mocked(createApolloSignalAudience).mock.calls.find((c) => c[0].type === "job_change");
    expect(jobChange?.[0].jobTitles).toBeNull();
    const [built] = await db.select().from(audienceSources).where(eq(audienceSources.audienceId, second.id));
    expect(built).toBeDefined();
  });
});
