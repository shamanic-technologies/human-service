import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const app = createTestApp();
const apiKeyHeader = {
  "X-API-Key": "test-api-key",
  "Content-Type": "application/json",
};

const ORG = "a0000000-0000-4000-8000-000000000001";
const BRAND = "b0000000-0000-4000-8000-00000000000a";
const NULL_A = "c0000000-0000-4000-8000-000000000001";
const NULL_B = "c0000000-0000-4000-8000-000000000002";
const DESCRIBED = "c0000000-0000-4000-8000-000000000003";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

function chatOk(description: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ json: { description } }),
    text: async () => "",
  };
}

// Default: derive a deterministic sentence from the audience name in the request
// body so each row gets a distinct description.
function wireDefault() {
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/internal/platform-complete")) {
      const body = JSON.parse(init.body ?? "{}") as { message?: string };
      const m = /Audience name: "([^"]*)"/.exec(body.message ?? "");
      const name = m?.[1] ?? "unknown";
      return chatOk(`Targets ${name} contacts.`);
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

async function seed() {
  await db.insert(audiences).values([
    {
      id: NULL_A,
      orgId: ORG,
      brandId: BRAND,
      name: "Agency Owners",
      filters: { titles: ["Owner"], industries: ["Marketing"] },
      status: "active",
      // description omitted -> null (pre-#82 row)
    },
    {
      id: NULL_B,
      orgId: ORG,
      brandId: BRAND,
      name: "Heads of Growth",
      filters: { titles: ["Head of Growth"] },
      status: "active",
    },
    {
      id: DESCRIBED,
      orgId: ORG,
      brandId: BRAND,
      name: "Already described",
      filters: { titles: ["CTO"] },
      status: "active",
      description: "An existing per-audience description.",
    },
  ]);
}

beforeEach(async () => {
  fetchSpy.mockReset();
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /internal/backfill-audience-descriptions", () => {
  it("dry-run counts null-description rows + samples them, calls no LLM, writes nothing", async () => {
    await seed();
    wireDefault();

    const res = await request(app)
      .post("/internal/backfill-audience-descriptions?dryRun=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.scanned).toBe(2); // NULL_A + NULL_B (DESCRIBED excluded)
    expect(res.body.wouldBackfill).toBe(2);
    expect(res.body.backfilled).toBe(0);
    expect(res.body.sample).toHaveLength(2);
    expect(res.body.sample.every((s: { description: null }) => s.description === null)).toBe(true);

    // No LLM call, nothing written.
    expect(fetchSpy).not.toHaveBeenCalled();
    const [a] = await db
      .select({ description: audiences.description })
      .from(audiences)
      .where(eq(audiences.id, NULL_A));
    expect(a.description).toBeNull();
  });

  it("real run writes a description for each null row, leaves described rows untouched, re-run is a no-op", async () => {
    await seed();
    wireDefault();

    const res = await request(app)
      .post("/internal/backfill-audience-descriptions?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.backfilled).toBe(2);
    expect(res.body.failed).toEqual([]);

    const [a] = await db
      .select({ description: audiences.description })
      .from(audiences)
      .where(eq(audiences.id, NULL_A));
    expect(a.description).toBe("Targets Agency Owners contacts.");

    const [b] = await db
      .select({ description: audiences.description })
      .from(audiences)
      .where(eq(audiences.id, NULL_B));
    expect(b.description).toBe("Targets Heads of Growth contacts.");

    // Pre-existing description untouched (NEVER overwritten).
    const [d] = await db
      .select({ description: audiences.description })
      .from(audiences)
      .where(eq(audiences.id, DESCRIBED));
    expect(d.description).toBe("An existing per-audience description.");

    // Re-run: no null rows left -> idempotent no-op.
    const reRun = await request(app)
      .post("/internal/backfill-audience-descriptions?dryRun=false")
      .set(apiKeyHeader);
    expect(reRun.body.scanned).toBe(0);
    expect(reRun.body.backfilled).toBe(0);
  });

  it("logs + skips a row whose LLM generation yields no description, still writes the others", async () => {
    await seed();
    // NULL_A's generation returns an empty description (per-row failure); NULL_B
    // succeeds.
    fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? "{}") as { message?: string };
      const isA = (body.message ?? "").includes("Agency Owners");
      return chatOk(isA ? "" : "Targets Heads of Growth contacts.");
    });

    const res = await request(app)
      .post("/internal/backfill-audience-descriptions?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.backfilled).toBe(1);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe(NULL_A);

    // NULL_A stays null (retried on re-run); NULL_B written.
    const [a] = await db
      .select({ description: audiences.description })
      .from(audiences)
      .where(eq(audiences.id, NULL_A));
    expect(a.description).toBeNull();
    const [b] = await db
      .select({ description: audiences.description })
      .from(audiences)
      .where(eq(audiences.id, NULL_B));
    expect(b.description).toBe("Targets Heads of Growth contacts.");
  });

  it("fails loud (502) when chat-service is unreachable", async () => {
    await seed();
    fetchSpy.mockImplementation(async () => {
      throw new Error("connect refused");
    });

    const res = await request(app)
      .post("/internal/backfill-audience-descriptions?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(502);
  });

  it("requires api key", async () => {
    const res = await request(app).post(
      "/internal/backfill-audience-descriptions"
    );
    expect(res.status).toBe(401);
  });
});
