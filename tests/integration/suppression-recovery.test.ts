import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  brandSuppressions,
  suppressionRecoveries,
} from "../../src/db/schema.js";
import {
  recordServe,
  filterSuppressed,
  getSuppressionSet,
  isEmailSuppressed,
  type ServedContact,
} from "../../src/services/suppression.js";
import {
  recoverSuppressions,
  revertSuppressionRecovery,
} from "../../src/services/suppression-recovery.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";

const app = createTestApp();

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_OTHER = "22222222-1111-4111-8111-111111111111";
const BRAND_A = "aaaaaaaa-1111-4111-8111-111111111111";
const BRAND_B = "bbbbbbbb-1111-4111-8111-111111111111";
const REASON = "instantly-timezone-enum-2026-08";

const contact = (over: Partial<ServedContact> = {}): ServedContact => ({
  email: "served@casco.com",
  linkedinUrl: "https://www.linkedin.com/in/served/",
  firstName: "Sara",
  lastName: "F",
  companyDomain: "casco.com",
  provider: "apollo",
  providerPersonId: "apollo-1",
  ...over,
});

beforeEach(async () => {
  await cleanTestData();
});

afterAll(async () => {
  await closeDb();
});

describe("recoverSuppressions", () => {
  it("dry-run reports the set with per-brand counts and writes nothing", async () => {
    await recordServe(ORG, [BRAND_A], [contact()]);
    await recordServe(ORG, [BRAND_B], [contact({ email: "other@casco.com" })]);

    const result = await recoverSuppressions(
      REASON,
      [
        { orgId: ORG, brandId: BRAND_A, email: "Served@Casco.com" },
        { orgId: ORG, brandId: BRAND_B, email: "other@casco.com" },
      ],
      { dryRun: true }
    );

    expect(result.dryRun).toBe(true);
    expect(result.distinct).toBe(2);
    expect(result.wouldRecover).toBe(2);
    expect(result.recovered).toBe(0);
    expect(
      [...result.byBrand].sort((a, b) => a.brandId.localeCompare(b.brandId))
    ).toEqual([
      { brandId: BRAND_A, count: 1 },
      { brandId: BRAND_B, count: 1 },
    ]);

    // Nothing written: both suppressions still live, ledger still empty.
    expect(await db.select().from(brandSuppressions)).toHaveLength(2);
    expect(await db.select().from(suppressionRecoveries)).toHaveLength(0);
  });

  it("archives verbatim, deletes the suppression, and makes the person emittable again", async () => {
    await recordServe(ORG, [BRAND_A], [contact()]);
    const [before] = await db.select().from(brandSuppressions);

    const result = await recoverSuppressions(
      REASON,
      [{ orgId: ORG, brandId: BRAND_A, email: "served@casco.com" }],
      { dryRun: false }
    );
    expect(result.recovered).toBe(1);

    expect(await db.select().from(brandSuppressions)).toHaveLength(0);

    const [archived] = await db.select().from(suppressionRecoveries);
    expect(archived.reason).toBe(REASON);
    expect(archived.suppressionId).toBe(before.id);
    expect(archived.emailNorm).toBe("served@casco.com");
    expect(archived.linkedinUrlNorm).toBe(before.linkedinUrlNorm);
    expect(archived.providerPersonId).toBe(before.providerPersonId);
    expect(archived.lastProvider).toBe(before.lastProvider);
    expect(archived.firstServedAt.getTime()).toBe(before.firstServedAt.getTime());
    expect(archived.lastServedAt.getTime()).toBe(before.lastServedAt.getTime());

    // Every read path the serve flow consults now lets them through again.
    const teasers = [
      {
        linkedinUrl: "https://www.linkedin.com/in/served/",
        providerPersonId: "apollo-1",
      },
    ];
    expect(await filterSuppressed(ORG, [BRAND_A], teasers)).toHaveLength(1);
    expect(await getSuppressionSet(ORG, [BRAND_A])).toEqual({
      emails: [],
      linkedinUrls: [],
    });
    expect(
      await isEmailSuppressed(ORG, [BRAND_A], "served@casco.com")
    ).toBe(false);
  });

  it("never touches a person outside the supplied set (same brand, same org)", async () => {
    await recordServe(ORG, [BRAND_A], [contact()]);
    await recordServe(
      ORG,
      [BRAND_A],
      [contact({ email: "contacted@casco.com", linkedinUrl: null, providerPersonId: "apollo-2" })]
    );

    await recoverSuppressions(
      REASON,
      [{ orgId: ORG, brandId: BRAND_A, email: "served@casco.com" }],
      { dryRun: false }
    );

    const left = await db.select().from(brandSuppressions);
    expect(left).toHaveLength(1);
    expect(left[0].emailNorm).toBe("contacted@casco.com");
    expect(
      await isEmailSuppressed(ORG, [BRAND_A], "contacted@casco.com")
    ).toBe(true);
  });

  it("is scoped to (org, brand, email) — a same-email serve under another brand or org survives", async () => {
    await recordServe(ORG, [BRAND_A, BRAND_B], [contact()]);
    await recordServe(ORG_OTHER, [BRAND_A], [contact()]);

    await recoverSuppressions(
      REASON,
      [{ orgId: ORG, brandId: BRAND_A, email: "served@casco.com" }],
      { dryRun: false }
    );

    const left = await db.select().from(brandSuppressions);
    expect(left).toHaveLength(2);
    expect(
      left.map((r) => `${r.orgId}|${r.brandId}`).sort()
    ).toEqual([`${ORG}|${BRAND_B}`, `${ORG_OTHER}|${BRAND_A}`].sort());
  });

  it("is idempotent — a re-run recovers 0 and reports the entries as alreadyRecovered", async () => {
    await recordServe(ORG, [BRAND_A], [contact()]);
    const entries = [
      { orgId: ORG, brandId: BRAND_A, email: "served@casco.com" },
    ];

    const first = await recoverSuppressions(REASON, entries, { dryRun: false });
    expect(first.recovered).toBe(1);

    const second = await recoverSuppressions(REASON, entries, { dryRun: false });
    expect(second.recovered).toBe(0);
    expect(second.wouldRecover).toBe(0);
    expect(second.alreadyRecovered).toBe(1);
    expect(second.notSuppressed).toBe(0);

    // Exactly one ledger row — the unique (reason, org, brand, email) index.
    expect(await db.select().from(suppressionRecoveries)).toHaveLength(1);
  });

  it("dedups duplicated input entries and counts never-suppressed ones honestly", async () => {
    await recordServe(ORG, [BRAND_A], [contact()]);

    const result = await recoverSuppressions(
      REASON,
      [
        { orgId: ORG, brandId: BRAND_A, email: "served@casco.com" },
        { orgId: ORG, brandId: BRAND_A, email: "SERVED@casco.com" },
        { orgId: ORG, brandId: BRAND_A, email: "never-served@casco.com" },
      ],
      { dryRun: false }
    );

    expect(result.requested).toBe(3);
    expect(result.distinct).toBe(2);
    expect(result.recovered).toBe(1);
    expect(result.notSuppressed).toBe(1);
  });

  it("fails loud on a blank email rather than silently dropping the entry", async () => {
    await expect(
      recoverSuppressions(
        REASON,
        [{ orgId: ORG, brandId: BRAND_A, email: "   " }],
        { dryRun: true }
      )
    ).rejects.toThrow(/blank email/);
  });
});

describe("revertSuppressionRecovery", () => {
  it("restores the archived rows verbatim and drops the ledger", async () => {
    await recordServe(ORG, [BRAND_A], [contact()]);
    const [before] = await db.select().from(brandSuppressions);
    await recoverSuppressions(
      REASON,
      [{ orgId: ORG, brandId: BRAND_A, email: "served@casco.com" }],
      { dryRun: false }
    );

    const dry = await revertSuppressionRecovery(REASON, { dryRun: true });
    expect(dry.wouldRestore).toBe(1);
    expect(dry.restored).toBe(0);
    expect(await db.select().from(brandSuppressions)).toHaveLength(0);

    const result = await revertSuppressionRecovery(REASON, { dryRun: false });
    expect(result.restored).toBe(1);

    const [after] = await db.select().from(brandSuppressions);
    expect(after.id).toBe(before.id);
    expect(after.emailNorm).toBe(before.emailNorm);
    expect(after.linkedinUrlNorm).toBe(before.linkedinUrlNorm);
    expect(after.firstServedAt.getTime()).toBe(before.firstServedAt.getTime());
    expect(after.lastServedAt.getTime()).toBe(before.lastServedAt.getTime());
    expect(await db.select().from(suppressionRecoveries)).toHaveLength(0);

    // Suppressed again for every read path.
    expect(await isEmailSuppressed(ORG, [BRAND_A], "served@casco.com")).toBe(true);
  });

  it("keeps a fresh post-recovery serve and never clobbers it", async () => {
    await recordServe(ORG, [BRAND_A], [contact()]);
    await recoverSuppressions(
      REASON,
      [{ orgId: ORG, brandId: BRAND_A, email: "served@casco.com" }],
      { dryRun: false }
    );
    // The recovery worked: the person was served again.
    await recordServe(ORG, [BRAND_A], [contact({ providerPersonId: "apollo-9" })]);
    const [fresh] = await db.select().from(brandSuppressions);

    const result = await revertSuppressionRecovery(REASON, { dryRun: false });
    expect(result.restored).toBe(0);
    expect(result.skippedResuppressed).toBe(1);

    const rows = await db.select().from(brandSuppressions);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(fresh.id);
    expect(rows[0].providerPersonId).toBe("apollo-9");
    expect(await db.select().from(suppressionRecoveries)).toHaveLength(0);
  });

  it("is idempotent — reverting an unknown reason is a no-op", async () => {
    const result = await revertSuppressionRecovery("no-such-reason", {
      dryRun: false,
    });
    expect(result).toMatchObject({ archived: 0, restored: 0, wouldRestore: 0 });
  });
});

describe("POST /internal/recover-suppressions", () => {
  it("requires service auth", async () => {
    const res = await request(app)
      .post("/internal/recover-suppressions")
      .send({ reason: REASON, entries: [] });
    expect(res.status).toBe(401);
  });

  it("400s on an empty entry list", async () => {
    const res = await request(app)
      .post("/internal/recover-suppressions")
      .set(getAuthHeaders())
      .send({ reason: REASON, entries: [] });
    expect(res.status).toBe(400);
  });

  it("dry-runs, then recovers, then reverts over HTTP", async () => {
    await recordServe(ORG, [BRAND_A], [contact()]);
    const body = {
      reason: REASON,
      entries: [{ orgId: ORG, brandId: BRAND_A, email: "served@casco.com" }],
    };

    const dry = await request(app)
      .post("/internal/recover-suppressions?dryRun=true")
      .set(getAuthHeaders())
      .send(body);
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, wouldRecover: 1, recovered: 0 });
    expect(await db.select().from(brandSuppressions)).toHaveLength(1);

    const real = await request(app)
      .post("/internal/recover-suppressions")
      .set(getAuthHeaders())
      .send(body);
    expect(real.status).toBe(200);
    expect(real.body).toMatchObject({ dryRun: false, recovered: 1 });
    expect(await db.select().from(brandSuppressions)).toHaveLength(0);

    const revert = await request(app)
      .post("/internal/recover-suppressions/revert")
      .set(getAuthHeaders())
      .send({ reason: REASON });
    expect(revert.status).toBe(200);
    expect(revert.body).toMatchObject({ restored: 1 });
    expect(
      await db
        .select()
        .from(brandSuppressions)
        .where(eq(brandSuppressions.orgId, ORG))
    ).toHaveLength(1);
  });
});
