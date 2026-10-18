import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences, audienceTeaserScreenings } from "../../src/db/schema.js";

const app = createTestApp();
const ORG = "00000000-0000-0000-0000-000000000001";
const ORG2 = "00000000-0000-0000-0000-000000000002";
const BRAND = "00000000-0000-4000-8000-0000000000c1";

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

async function audience(name: string, orgId: string) {
  const [row] = await db
    .insert(audiences)
    .values({ orgId, brandId: BRAND, name, provider: "apollo", filters: { person_titles: ["X"] }, status: "active" })
    .returning();
  return row;
}

let n = 0;
async function screen(audienceId: string, orgId: string, yes: number | null, verdict: boolean, at: string) {
  n += 1;
  await db.insert(audienceTeaserScreenings).values({
    orgId, audienceId, providerPersonId: `p${n}`, teaser: {} as never, verdict, yesProbability: yes,
    model: yes === null ? "zai/glm-flash" : "typesafe/jev-1.13.0", promptVersion: yes === null ? "v1" : "v2",
    createdAt: new Date(at),
  });
}

describe("GET /internal/research/teaser-screenings", () => {
  it("requires the api key", async () => {
    const res = await request(app).get("/internal/research/teaser-screenings");
    expect(res.status).toBe(401);
  });

  it("counts Jev-judged screenings per month, verdict and P(yes) bucket, fleet-wide", async () => {
    const a = await audience("A", ORG);
    const b = await audience("B", ORG2);
    await screen(a.id, ORG, 0.1, false, "2026-09-28T10:00:00Z");
    await screen(a.id, ORG, 0.5, false, "2026-09-29T10:00:00Z"); // 0.5 sits in 0.2-0.5
    await screen(a.id, ORG, 0.65, false, "2026-09-28T11:00:00Z"); // old 0.80 bar
    await screen(b.id, ORG2, 0.65, true, "2026-09-30T23:59:00Z");
    await screen(b.id, ORG2, 0.95, true, "2026-10-02T09:00:00Z");
    await screen(a.id, ORG, null, true, "2026-09-20T09:00:00Z"); // v1: excluded

    const res = await request(app).get("/internal/research/teaser-screenings").set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ screened: 5, passed: 2, declined: 3, distinctOrgs: 2, distinctAudiences: 2 });
    expect(res.body.firstScreenedAt).toBe("2026-09-28T10:00:00.000Z");
    expect(res.body.lastScreenedAt).toBe("2026-10-02T09:00:00.000Z");
    expect(res.body.months.map((m: { month: string }) => m.month)).toEqual(["2026-09", "2026-10"]);
    const [sep, oct] = res.body.months;
    expect(sep).toMatchObject({ screened: 4, passed: 1, declined: 3 });
    expect(sep.buckets).toEqual({
      below_0_2: { screened: 1, passed: 0, declined: 1 },
      "0_2_to_0_5": { screened: 1, passed: 0, declined: 1 },
      "0_5_to_0_8": { screened: 2, passed: 1, declined: 1 },
      "0_8_and_above": { screened: 0, passed: 0, declined: 0 },
    });
    expect(oct.buckets["0_8_and_above"]).toEqual({ screened: 1, passed: 1, declined: 0 });
  });

  it("answers zeros when nothing was screened", async () => {
    const res = await request(app).get("/internal/research/teaser-screenings").set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      screen: "human-service", firstScreenedAt: null, lastScreenedAt: null,
      totals: { screened: 0, passed: 0, declined: 0, distinctOrgs: 0, distinctAudiences: 0 }, months: [],
    });
  });
});
