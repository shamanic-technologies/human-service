import { describe, it, expect, beforeEach, afterAll } from "vitest";
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
const ORG2 = "a0000000-0000-4000-8000-0000000000b2";
const BRAND = "b0000000-0000-4000-8000-00000000000a";

const ACTIVE_AGENCY = "c0000000-0000-4000-8000-000000000001";
const DEPR_AGENCY = "c0000000-0000-4000-8000-000000000002";
const DEPR_NO_SIBLING = "c0000000-0000-4000-8000-000000000003";
const SUGGESTED_SOLO = "c0000000-0000-4000-8000-000000000004";
const DEPR_SOLO = "c0000000-0000-4000-8000-000000000005";
// Cross-org collision: same base name in ORG2 must NOT be picked for ORG's row.
const OTHER_ORG_AGENCY = "c0000000-0000-4000-8000-000000000006";

async function seed() {
  await db.insert(audiences).values([
    // Pair 1: active apollo "Agency Owners and MDs" + deprecated apify variant.
    {
      id: ACTIVE_AGENCY,
      orgId: ORG,
      brandId: BRAND,
      name: "Agency Owners and MDs",
      provider: "apollo",
      status: "active",
      source: "migrated_from_apify",
    },
    {
      id: DEPR_AGENCY,
      orgId: ORG,
      brandId: BRAND,
      name: "Agency Owners and MDs [Apify]",
      provider: "apify",
      status: "deprecated",
    },
    // Deprecated variant whose base name has no active sibling -> skipped.
    {
      id: DEPR_NO_SIBLING,
      orgId: ORG,
      brandId: BRAND,
      name: "Vanished Audience [Apify]",
      provider: "apify",
      status: "deprecated",
    },
    // Pair 2: a SUGGESTED (non-deprecated) sibling is a valid canonical target.
    {
      id: SUGGESTED_SOLO,
      orgId: ORG,
      brandId: BRAND,
      name: "Solo Founders",
      provider: "apollo",
      status: "suggested",
    },
    {
      id: DEPR_SOLO,
      orgId: ORG,
      brandId: BRAND,
      name: "Solo Founders [Apify]",
      provider: "apify",
      status: "deprecated",
    },
    // Same base name in a DIFFERENT org — must never be picked for ORG's row.
    {
      id: OTHER_ORG_AGENCY,
      orgId: ORG2,
      brandId: BRAND,
      name: "Agency Owners and MDs",
      provider: "apollo",
      status: "active",
    },
  ]);
}

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /internal/backfill-canonical-audience-links", () => {
  it("requires api key", async () => {
    const res = await request(app).post(
      "/internal/backfill-canonical-audience-links"
    );
    expect(res.status).toBe(401);
  });

  it("dry-run resolves links + returns counts WITHOUT writing", async () => {
    await seed();
    const res = await request(app)
      .post("/internal/backfill-canonical-audience-links?dryRun=true")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.scanned).toBe(3); // 3 deprecated rows
    expect(res.body.wouldLink).toBe(2); // agency + solo
    expect(res.body.linked).toBe(0); // dry-run writes nothing
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].id).toBe(DEPR_NO_SIBLING);
    expect(res.body.skipped[0].reason).toBe("no active sibling");

    // Nothing written.
    const [depr] = await db
      .select({ canonical: audiences.canonicalAudienceId })
      .from(audiences)
      .where(eq(audiences.id, DEPR_AGENCY));
    expect(depr.canonical).toBeNull();
  });

  it("real run links each deprecated variant to its same-org canonical sibling; re-run is idempotent", async () => {
    await seed();
    const res = await request(app)
      .post("/internal/backfill-canonical-audience-links?dryRun=false")
      .set(apiKeyHeader);

    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(2);
    expect(res.body.wouldLink).toBe(2);
    expect(res.body.skipped).toHaveLength(1);

    // Agency deprecated -> active apollo twin (same org).
    const [agency] = await db
      .select({ canonical: audiences.canonicalAudienceId })
      .from(audiences)
      .where(eq(audiences.id, DEPR_AGENCY));
    expect(agency.canonical).toBe(ACTIVE_AGENCY);

    // Solo deprecated -> the SUGGESTED (non-deprecated) sibling.
    const [solo] = await db
      .select({ canonical: audiences.canonicalAudienceId })
      .from(audiences)
      .where(eq(audiences.id, DEPR_SOLO));
    expect(solo.canonical).toBe(SUGGESTED_SOLO);

    // Cross-org sibling was NOT picked (different org).
    expect(agency.canonical).not.toBe(OTHER_ORG_AGENCY);

    // No-sibling row left unlinked.
    const [orphan] = await db
      .select({ canonical: audiences.canonicalAudienceId })
      .from(audiences)
      .where(eq(audiences.id, DEPR_NO_SIBLING));
    expect(orphan.canonical).toBeNull();

    // Re-run: linked rows are now excluded (canonical IS NOT NULL) -> links 0.
    const reRun = await request(app)
      .post("/internal/backfill-canonical-audience-links?dryRun=false")
      .set(apiKeyHeader);
    expect(reRun.body.scanned).toBe(1); // only the orphan remains unlinked
    expect(reRun.body.linked).toBe(0);
  });
});
