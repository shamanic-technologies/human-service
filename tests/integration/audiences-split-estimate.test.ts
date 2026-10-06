// Approximate size of proposed split segments: one cheap filter draft for the
// whole list, one free dry-run count per segment, one repair round for drafts
// refused or matching nobody. Creates no audience.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { resetFiltersPromptCache } from "../../src/services/audience-split-estimate.js";

const app = createTestApp();
const BRAND = "00000000-0000-4000-8000-0000000000b1";

const fetchSpy = vi.fn();
const fetchBefore = globalThis.fetch;

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}
function bad(status: number, json: unknown) {
  return { ok: false, status, json: async () => json, text: async () => JSON.stringify(json) };
}

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockReset();
  resetFiltersPromptCache();
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  await cleanTestData();
});

afterAll(async () => {
  globalThis.fetch = fetchBefore;
  await closeDb();
});

const SEGMENTS = [
  { name: "US SaaS founders", description: "Founders of B2B SaaS companies based in the United States.", icon: "globe-hemisphere-west" },
  { name: "Europe SaaS founders", description: "Founders of B2B SaaS companies based in Europe." },
];

function estimate(body: Record<string, unknown>) {
  return request(app).post("/orgs/audiences/split/estimate").set(getAuthHeaders()).send(body);
}

describe("POST /orgs/audiences/split/estimate", () => {
  it("drafts filters for the whole list in ONE call and counts each segment for free", async () => {
    const dryRunBodies: Array<Record<string, unknown>> = [];
    const completes: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/search/filters-prompt")) return ok({ prompt: "## person_titles ...", schemaVersion: "abc" });
      if (u.endsWith("/complete")) {
        completes.push(JSON.parse(init.body ?? "{}"));
        return ok({
          json: {
            segments: [
              { index: 1, filters: { person_titles: ["Founder", "Co-Founder"], person_locations: ["United States"], buying_signal: { type: "hiring", window_days: 30 } } },
              { index: 2, filters: { person_seniorities: ["founder"], person_locations: ["Europe"] } },
            ],
          },
        });
      }
      if (u.endsWith("/search/dry-run")) {
        const body = JSON.parse(init.body ?? "{}");
        dryRunBodies.push(body);
        return ok({ totalEntries: body.person_titles ? 41234 : 987, validationErrors: [] });
      }
      throw new Error("unexpected url " + u);
    });

    const res = await estimate({ brandId: BRAND, segments: SEGMENTS });
    expect(res.status).toBe(200);
    expect(res.body.estimates).toEqual([
      { name: "US SaaS founders", estimatedPeople: 41000, unavailableReason: null },
      { name: "Europe SaaS founders", estimatedPeople: 990, unavailableReason: null },
    ]);
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({ provider: "google", model: "flash-pro", disableThinking: true });
    expect(String(completes[0].message)).toContain("Segment 2: Europe SaaS founders");
    // Similar titles forced off where titles are used; buying signal never sent.
    const titled = dryRunBodies.find((b) => b.person_titles)!;
    expect(titled.include_similar_titles).toBe(false);
    expect(titled.buying_signal).toBeUndefined();
    expect(dryRunBodies.find((b) => !b.person_titles)!.include_similar_titles).toBeUndefined();
    // Nothing persisted.
    expect(await db.select().from(audiences)).toHaveLength(0);
  });

  it("repairs only the segments whose draft was refused or matched nobody", async () => {
    let completeCalls = 0;
    const repairMessages: string[] = [];
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.endsWith("/search/filters-prompt")) return ok({ prompt: "ref", schemaVersion: "abc" });
      if (u.endsWith("/complete")) {
        completeCalls += 1;
        if (completeCalls === 1) {
          return ok({ json: { segments: [{ index: 1, filters: { bogus_field: ["x"] } }, { index: 2, filters: { q_keywords: "nothing" } }] } });
        }
        repairMessages.push(JSON.parse(init.body ?? "{}").message);
        return ok({ json: { segments: [{ index: 1, filters: { person_seniorities: ["founder"] } }, { index: 2, filters: { person_locations: ["Europe"] } }] } });
      }
      if (u.endsWith("/search/dry-run")) {
        const body = JSON.parse(init.body ?? "{}");
        if (body.bogus_field) return bad(400, { totalEntries: 0, validationErrors: ["Unrecognized key: bogus_field"] });
        if (body.q_keywords) return ok({ totalEntries: 0, validationErrors: [] });
        return ok({ totalEntries: 12345, validationErrors: [] });
      }
      throw new Error("unexpected url " + u);
    });

    const res = await estimate({ brandId: BRAND, segments: SEGMENTS });
    expect(res.status).toBe(200);
    expect(completeCalls).toBe(2);
    expect(repairMessages[0]).toContain("bogus_field");
    expect(repairMessages[0]).toContain("matched 0 people");
    expect(res.body.estimates.map((e: { estimatedPeople: number }) => e.estimatedPeople)).toEqual([12000, 12000]);
  });

  it("names the segment it could not measure instead of inventing a number", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/search/filters-prompt")) return ok({ prompt: "ref", schemaVersion: "abc" });
      if (u.endsWith("/complete")) return ok({ json: { segments: [{ index: 1, filters: { person_seniorities: ["founder"] } }] } });
      if (u.endsWith("/search/dry-run")) return ok({ totalEntries: 500, validationErrors: [] });
      throw new Error("unexpected url " + u);
    });
    const res = await estimate({ brandId: BRAND, segments: SEGMENTS });
    expect(res.status).toBe(200);
    expect(res.body.estimates[1]).toEqual({ name: "Europe SaaS founders", estimatedPeople: null, unavailableReason: "no_filters_drafted" });
  });

  it("fails loud (502) when the people search itself is down", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/search/filters-prompt")) return ok({ prompt: "ref", schemaVersion: "abc" });
      if (u.endsWith("/complete")) return ok({ json: { segments: [{ index: 1, filters: { person_seniorities: ["founder"] } }, { index: 2, filters: { person_seniorities: ["owner"] } }] } });
      if (u.endsWith("/search/dry-run")) return bad(500, { error: "apollo down" });
      throw new Error("unexpected url " + u);
    });
    const res = await estimate({ brandId: BRAND, segments: SEGMENTS });
    expect(res.status).toBe(502);
  });

  it("rejects more than 8 segments", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, description: `Segment ${i}` }));
    const res = await estimate({ brandId: BRAND, segments: many });
    expect(res.status).toBe(400);
  });
});
