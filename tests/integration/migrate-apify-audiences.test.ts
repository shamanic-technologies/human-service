import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { and, eq } from "drizzle-orm";

const app = createTestApp();
const apiKeyHeader = {
  "X-API-Key": "test-api-key",
  "Content-Type": "application/json",
};

const ORG = "a0000000-0000-4000-8000-000000000001";
const BRAND = "b0000000-0000-4000-8000-00000000000a";
const USER = "a0000000-0000-4000-8000-000000000002";
const APIFY_ACTIVE = "c0000000-0000-4000-8000-000000000001";
const APIFY_SUGGESTED = "c0000000-0000-4000-8000-000000000002";
const APIFY_DEPRECATED = "c0000000-0000-4000-8000-000000000003";
const APOLLO_KEEP = "c0000000-0000-4000-8000-000000000004";

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

type Action = Record<string, unknown>;

// Mock the apollo provider + chat-service platform LLM by URL. The migration's
// refineFilters("apollo", …, { usePlatformLLM: true }) hits:
//   /search/filters-prompt + /reference/industries (apollo rulebook),
//   /internal/platform-complete (ORG-LESS layer-2 LLM — no /complete),
//   /search/dry-run (apollo free count).
function wire(opts?: {
  dryRunCount?: number;
  actByName?: (name: string, cleanTests: number) => Action;
}) {
  const dryRunCount = opts?.dryRunCount ?? 500;
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/search/filters-prompt"))
      return ok({ prompt: "RULES", schemaVersion: "1" });
    if (u.endsWith("/reference/industries"))
      return ok({ industries: [{ name: "Computer Software" }] });
    if (u.endsWith("/internal/platform-complete")) {
      const body = JSON.parse(init.body ?? "{}") as { message?: string };
      const msg = body.message ?? "";
      const name = (/name: (.+)/.exec(msg)?.[1] ?? "").trim();
      const cleanTests = (msg.match(/-> count=/g) ?? []).length;
      if (opts?.actByName) return ok({ json: opts.actByName(name, cleanTests) });
      return ok({
        json:
          cleanTests === 0
            ? { action: "test", filters: { titles: ["CTO"] } }
            : { action: "confirm" },
      });
    }
    if (u.endsWith("/search/dry-run")) return ok({ totalEntries: dryRunCount });
    throw new Error(`unexpected fetch ${u}`);
  });
}

async function seed() {
  await db.insert(audiences).values([
    {
      id: APIFY_ACTIVE,
      orgId: ORG,
      brandId: BRAND,
      name: "Active Apify",
      description: "active apify audience",
      provider: "apify",
      status: "active",
      filters: { titles: ["Owner"] },
      apifyCount: 40000,
      createdByUserId: USER,
    },
    {
      id: APIFY_SUGGESTED,
      orgId: ORG,
      brandId: BRAND,
      name: "Suggested Apify",
      description: "suggested apify audience",
      provider: "apify",
      status: "suggested",
      filters: { titles: ["Head"] },
      apifyCount: 30000,
      createdByUserId: USER,
    },
    {
      id: APIFY_DEPRECATED,
      orgId: ORG,
      brandId: BRAND,
      name: "Dead Apify [Apify]",
      provider: "apify",
      status: "deprecated",
      filters: { titles: ["X"] },
      createdByUserId: USER,
    },
    {
      id: APOLLO_KEEP,
      orgId: ORG,
      brandId: BRAND,
      name: "Apollo Keep",
      provider: "apollo",
      status: "active",
      filters: { titles: ["CEO"] },
      createdByUserId: USER,
    },
  ]);
}

beforeEach(async () => {
  fetchSpy.mockReset();
  process.env.CHAT_SERVICE_URL = "http://chat:8080";
  process.env.CHAT_SERVICE_API_KEY = "chat-key";
  process.env.APOLLO_SERVICE_URL = "http://apollo:8080";
  process.env.APOLLO_SERVICE_API_KEY = "apollo-key";
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /internal/migrate-apify-audiences-to-apollo", () => {
  it("dry-run scans non-deprecated apify rows, calls nothing, writes nothing", async () => {
    await seed();
    wire();

    const res = await request(app)
      .post("/internal/migrate-apify-audiences-to-apollo?dryRun=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.scanned).toBe(2); // active + suggested (deprecated + apollo excluded)
    expect(res.body.wouldMigrate).toBe(2);
    expect(res.body.migrated).toEqual([]);
    expect(res.body.sample).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Nothing written: the apify rows keep provider=apify.
    const [a] = await db
      .select({ provider: audiences.provider, status: audiences.status })
      .from(audiences)
      .where(eq(audiences.id, APIFY_ACTIVE));
    expect(a.provider).toBe("apify");
    expect(a.status).toBe("active");
  });

  it("real run creates an apollo twin (mirrored status) + deprecates the apify row; re-run is idempotent", async () => {
    await seed();
    wire({ dryRunCount: 777 });

    const res = await request(app)
      .post("/internal/migrate-apify-audiences-to-apollo?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.migrated).toHaveLength(2);
    expect(res.body.failed).toEqual([]);

    // apify rows are deprecated + renamed [Apify].
    const [oldActive] = await db
      .select()
      .from(audiences)
      .where(eq(audiences.id, APIFY_ACTIVE));
    expect(oldActive.status).toBe("deprecated");
    expect(oldActive.name).toBe("Active Apify [Apify]");
    expect(oldActive.provider).toBe("apify");

    // apollo twin: original name, provider apollo, mirrored status, re-derived
    // filters, apollo count snapshot, provenance tag.
    const [twin] = await db
      .select()
      .from(audiences)
      .where(
        and(
          eq(audiences.name, "Active Apify"),
          eq(audiences.provider, "apollo")
        )
      );
    expect(twin.status).toBe("active");
    expect(twin.source).toBe("migrated_from_apify");
    expect(twin.filters).toEqual({ titles: ["CTO"] });
    expect(twin.apolloCount).toBe(777);
    expect(twin.apifyCount).toBeNull();
    expect(twin.createdByUserId).toBe(USER);

    // suggested apify → apollo twin keeps suggested status (NOT auto-activated).
    const [suggestedTwin] = await db
      .select({ status: audiences.status })
      .from(audiences)
      .where(
        and(
          eq(audiences.name, "Suggested Apify"),
          eq(audiences.provider, "apollo")
        )
      );
    expect(suggestedTwin.status).toBe("suggested");

    // Re-run: all apify rows are now deprecated → nothing left to migrate.
    const reRun = await request(app)
      .post("/internal/migrate-apify-audiences-to-apollo?dryRun=false")
      .set(apiKeyHeader);
    expect(reRun.body.scanned).toBe(0);
    expect(reRun.body.migrated).toEqual([]);
  });

  it("a row whose apollo re-derivation yields no usable filters is counted failed + left untouched", async () => {
    await seed();
    // "Active Apify" exhausts immediately (no clean test → empty filters);
    // "Suggested Apify" confirms normally.
    wire({
      actByName: (name, cleanTests) => {
        if (name === "Active Apify") return { action: "exhausted", reason: "nope" };
        return cleanTests === 0
          ? { action: "test", filters: { titles: ["CTO"] } }
          : { action: "confirm" };
      },
    });

    const res = await request(app)
      .post("/internal/migrate-apify-audiences-to-apollo?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.migrated).toHaveLength(1);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe(APIFY_ACTIVE);

    // The failed apify row is untouched (still apify + active, original name).
    const [a] = await db
      .select()
      .from(audiences)
      .where(eq(audiences.id, APIFY_ACTIVE));
    expect(a.provider).toBe("apify");
    expect(a.status).toBe("active");
    expect(a.name).toBe("Active Apify");
  });

  it("fails loud (502) when apollo / chat-service is unreachable", async () => {
    await seed();
    fetchSpy.mockImplementation(async () => {
      throw new Error("connect refused");
    });

    const res = await request(app)
      .post("/internal/migrate-apify-audiences-to-apollo?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(502);
  });

  it("requires api key", async () => {
    const res = await request(app).post(
      "/internal/migrate-apify-audiences-to-apollo"
    );
    expect(res.status).toBe(401);
  });
});
