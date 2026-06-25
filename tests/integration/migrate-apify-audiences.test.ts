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

interface ApolloResp {
  apolloAudienceId: string;
  filters: Record<string, unknown>;
  count: number;
}

// "One filter vocabulary" Wave 2: the migration asks apollo-service to BUILD a
// faithful Apollo audience from the apify row's name + description
// (POST /audiences/suggest-from-segment → {apolloAudienceId, filters, count}).
// No in-human-service layer-2 loop / filters-prompt / industries / dry-run anymore.
function wire(opts?: {
  count?: number;
  byName?: (name: string) => ApolloResp;
}) {
  const count = opts?.count ?? 500;
  let seq = 0;
  fetchSpy.mockImplementation(async (url: string, init: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/audiences/suggest-from-segment")) {
      const body = JSON.parse(init.body ?? "{}") as { name: string };
      if (opts?.byName) return ok(opts.byName(body.name));
      return ok({
        apolloAudienceId: `apollo-${++seq}`,
        filters: { personTitles: ["CTO"] },
        count,
      });
    }
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
    wire({ count: 777 });

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

    // apollo twin: original name, provider apollo, mirrored status, the faithful
    // apollo filters + pointer from apollo-service, apollo count snapshot,
    // provenance tag.
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
    expect(twin.filters).toEqual({ personTitles: ["CTO"] });
    expect(twin.apolloAudienceId).toMatch(/^apollo-/);
    expect(twin.apolloCount).toBe(777);
    expect(twin.apifyCount).toBeNull();
    expect(twin.createdByUserId).toBe(USER);

    // The deprecated apify row carries a durable canonical link to its twin.
    expect(oldActive.canonicalAudienceId).toBe(twin.id);

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
    // apollo-service yields an EMPTY filter set for "Active Apify" (no usable
    // audience → migration returns null → counted failed); "Suggested Apify" is fine.
    wire({
      byName: (name) =>
        name === "Active Apify"
          ? { apolloAudienceId: "empty", filters: {}, count: 0 }
          : { apolloAudienceId: "ok", filters: { personTitles: ["CTO"] }, count: 500 },
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

  it("async=true responds 202 immediately + runs the sweep in the background", async () => {
    await seed();
    wire({ count: 123 });

    const res = await request(app)
      .post("/internal/migrate-apify-audiences-to-apollo?dryRun=false&async=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ started: true, scanned: 2 });

    // Background sweep is fire-and-forget; poll the DB until it lands.
    let twins: Array<{ id: string }> = [];
    for (let i = 0; i < 50; i++) {
      twins = await db
        .select({ id: audiences.id })
        .from(audiences)
        .where(eq(audiences.source, "migrated_from_apify"));
      if (twins.length >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(twins.length).toBe(2);

    // apify rows deprecated.
    const [a] = await db
      .select({ status: audiences.status })
      .from(audiences)
      .where(eq(audiences.id, APIFY_ACTIVE));
    expect(a.status).toBe("deprecated");
  });

  it("a provider/LLM outage is a PER-ROW failure (200, nothing migrated), not a whole-sweep abort", async () => {
    await seed();
    // Every provider call throws — each audience fails its refine, but the sweep
    // continues and reports them all in `failed` (a single flaky audience must
    // not block the others).
    fetchSpy.mockImplementation(async () => {
      throw new Error("connect refused");
    });

    const res = await request(app)
      .post("/internal/migrate-apify-audiences-to-apollo?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.migrated).toEqual([]);
    expect(res.body.failed).toHaveLength(2);

    // Both apify rows untouched (retried on re-run).
    const [a] = await db
      .select({ provider: audiences.provider, status: audiences.status })
      .from(audiences)
      .where(eq(audiences.id, APIFY_ACTIVE));
    expect(a.provider).toBe("apify");
    expect(a.status).toBe("active");
  });

  it("fails loud (502) on missing provider config (truly systemic)", async () => {
    await seed();
    wire();
    delete process.env.APOLLO_SERVICE_URL; // requireApollo → ProviderConfigError

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
