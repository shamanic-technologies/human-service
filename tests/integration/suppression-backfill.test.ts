import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  brandSuppressions,
  leadServes,
  suppressionBackfills,
} from "../../src/db/schema.js";
import {
  recordServe,
  filterSuppressed,
  getSuppressionSet,
  isEmailSuppressed,
  type ServedContact,
} from "../../src/services/suppression.js";
import {
  backfillSentSuppressions,
  revertSentSuppressionBackfill,
} from "../../src/services/suppression-backfill.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";

const app = createTestApp();

const ORG = "11111111-1111-4111-8111-111111111111";
const BRAND_A = "aaaaaaaa-1111-4111-8111-111111111111";
const BRAND_B = "bbbbbbbb-1111-4111-8111-111111111111";
const REASON = "pre-guard-sends-2026-08";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

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

describe("backfillSentSuppressions", () => {
  it("dry-run reports the set, its in-window share and per-brand counts, and writes nothing", async () => {
    const result = await backfillSentSuppressions(
      REASON,
      [
        // Inside the 3-month window: this one actually stops a re-serve today.
        {
          orgId: ORG,
          brandId: BRAND_A,
          email: "Emailed@Casco.com",
          sentAt: daysAgo(30).toISOString(),
        },
        // Emailed long ago: recorded truthfully, suppresses nothing now.
        {
          orgId: ORG,
          brandId: BRAND_B,
          email: "old@casco.com",
          sentAt: daysAgo(200).toISOString(),
        },
      ],
      { dryRun: true }
    );

    expect(result.dryRun).toBe(true);
    expect(result.distinct).toBe(2);
    expect(result.wouldBackfill).toBe(2);
    expect(result.wouldSuppressNow).toBe(1);
    expect(result.backfilled).toBe(0);
    expect(
      [...result.byBrand].sort((a, b) => a.brandId.localeCompare(b.brandId))
    ).toEqual([
      { brandId: BRAND_A, count: 1, withinWindow: 1 },
      { brandId: BRAND_B, count: 1, withinWindow: 0 },
    ]);

    expect(await db.select().from(brandSuppressions)).toHaveLength(0);
    expect(await db.select().from(suppressionBackfills)).toHaveLength(0);
  });

  it("suppresses a person emailed inside the window, dated from the real send", async () => {
    const sentAt = daysAgo(30);
    const result = await backfillSentSuppressions(
      REASON,
      [
        {
          orgId: ORG,
          brandId: BRAND_A,
          email: "emailed@casco.com",
          sentAt: sentAt.toISOString(),
        },
      ],
      { dryRun: false }
    );
    expect(result.backfilled).toBe(1);

    const [row] = await db.select().from(brandSuppressions);
    expect(row.emailNorm).toBe("emailed@casco.com");
    // Dated from the real send — NOT now(): the person keeps the remainder of
    // their own window instead of being granted a fresh three months.
    expect(row.lastServedAt.getTime()).toBe(sentAt.getTime());
    expect(row.firstServedAt.getTime()).toBe(sentAt.getTime());
    // Unknown by construction, never invented.
    expect(row.linkedinUrlNorm).toBeNull();
    expect(row.providerPersonId).toBeNull();
    expect(row.lastProvider).toBeNull();

    // The read paths now exclude them for this brand.
    expect(await isEmailSuppressed(ORG, [BRAND_A], "emailed@casco.com")).toBe(
      true
    );
    expect((await getSuppressionSet(ORG, [BRAND_A])).emails).toEqual([
      "emailed@casco.com",
    ]);
    // ...and only for this brand.
    expect(await isEmailSuppressed(ORG, [BRAND_B], "emailed@casco.com")).toBe(
      false
    );

    // Identifiable: the ledger names exactly what was created.
    const [ledger] = await db.select().from(suppressionBackfills);
    expect(ledger.reason).toBe(REASON);
    expect(ledger.suppressionId).toBe(row.id);
    expect(ledger.emailNorm).toBe("emailed@casco.com");
    expect(ledger.sentAt.getTime()).toBe(sentAt.getTime());
  });

  it("writes a lapsed send truthfully without suppressing anyone", async () => {
    await backfillSentSuppressions(
      REASON,
      [
        {
          orgId: ORG,
          brandId: BRAND_A,
          email: "old@casco.com",
          sentAt: daysAgo(200).toISOString(),
        },
      ],
      { dryRun: false }
    );

    // The row exists, but the untouched 3-month window keeps them contactable.
    expect(await db.select().from(brandSuppressions)).toHaveLength(1);
    expect(await isEmailSuppressed(ORG, [BRAND_A], "old@casco.com")).toBe(false);
    expect((await getSuppressionSet(ORG, [BRAND_A])).emails).toEqual([]);
  });

  it("never touches the append-only bronze audit", async () => {
    await backfillSentSuppressions(
      REASON,
      [
        {
          orgId: ORG,
          brandId: BRAND_A,
          email: "emailed@casco.com",
          sentAt: daysAgo(10).toISOString(),
        },
      ],
      { dryRun: false }
    );
    expect(await db.select().from(leadServes)).toHaveLength(0);
  });

  it("leaves a person the caller did not supply completely untouched", async () => {
    await backfillSentSuppressions(
      REASON,
      [
        {
          orgId: ORG,
          brandId: BRAND_A,
          email: "emailed@casco.com",
          sentAt: daysAgo(10).toISOString(),
        },
      ],
      { dryRun: false }
    );

    // Served but never emailed ⟹ not in the supplied set ⟹ no row, still
    // servable. Backfilling bare serves is exactly what this must not do.
    expect(
      await isEmailSuppressed(ORG, [BRAND_A], "served-never-sent@casco.com")
    ).toBe(false);
    expect(await db.select().from(brandSuppressions)).toHaveLength(1);
  });

  it("is idempotent: a re-run writes nothing new and says so", async () => {
    const entries = [
      {
        orgId: ORG,
        brandId: BRAND_A,
        email: "emailed@casco.com",
        sentAt: daysAgo(30).toISOString(),
      },
    ];
    const first = await backfillSentSuppressions(REASON, entries, {
      dryRun: false,
    });
    expect(first.backfilled).toBe(1);

    const second = await backfillSentSuppressions(REASON, entries, {
      dryRun: false,
    });
    expect(second.backfilled).toBe(0);
    expect(second.wouldBackfill).toBe(0);
    expect(second.alreadyBackfilled).toBe(1);
    expect(await db.select().from(brandSuppressions)).toHaveLength(1);
    expect(await db.select().from(suppressionBackfills)).toHaveLength(1);
  });

  it("never re-dates a live suppression row", async () => {
    await recordServe(ORG, [BRAND_A], [contact({ email: "emailed@casco.com" })]);
    const [before] = await db.select().from(brandSuppressions);

    const result = await backfillSentSuppressions(
      REASON,
      [
        {
          orgId: ORG,
          brandId: BRAND_A,
          email: "emailed@casco.com",
          sentAt: daysAgo(80).toISOString(),
        },
      ],
      { dryRun: false }
    );
    expect(result.alreadySuppressed).toBe(1);
    expect(result.backfilled).toBe(0);

    const [after] = await db.select().from(brandSuppressions);
    expect(after.lastServedAt.getTime()).toBe(before.lastServedAt.getTime());
    expect(after.lastProvider).toBe("apollo");
  });

  it("collapses several sends of one person onto the latest one", async () => {
    const latest = daysAgo(5);
    const result = await backfillSentSuppressions(
      REASON,
      [
        {
          orgId: ORG,
          brandId: BRAND_A,
          email: "emailed@casco.com",
          sentAt: daysAgo(80).toISOString(),
        },
        {
          orgId: ORG,
          brandId: BRAND_A,
          email: "EMAILED@casco.com",
          sentAt: latest.toISOString(),
        },
      ],
      { dryRun: false }
    );

    expect(result.requested).toBe(2);
    expect(result.distinct).toBe(1);
    const [row] = await db.select().from(brandSuppressions);
    expect(row.lastServedAt.getTime()).toBe(latest.getTime());
  });

  it("fails loud on a blank email or an unparseable send time", async () => {
    await expect(
      backfillSentSuppressions(
        REASON,
        [
          {
            orgId: ORG,
            brandId: BRAND_A,
            email: "   ",
            sentAt: daysAgo(1).toISOString(),
          },
        ],
        { dryRun: true }
      )
    ).rejects.toThrow(/blank email/);

    await expect(
      backfillSentSuppressions(
        REASON,
        [
          {
            orgId: ORG,
            brandId: BRAND_A,
            email: "emailed@casco.com",
            sentAt: "not-a-date",
          },
        ],
        { dryRun: true }
      )
    ).rejects.toThrow(/unparseable sentAt/);
  });

  it("stops the re-serve that the missing suppression allowed", async () => {
    // A person emailed pre-guard: the apollo teaser filter cannot see them
    // because they carry no suppression row.
    const teasers = [
      {
        linkedinUrl: "https://www.linkedin.com/in/emailed/",
        providerPersonId: "apollo-9",
      },
    ];
    expect(await filterSuppressed(ORG, [BRAND_A], teasers)).toHaveLength(1);

    await backfillSentSuppressions(
      REASON,
      [
        {
          orgId: ORG,
          brandId: BRAND_A,
          email: "emailed@casco.com",
          sentAt: daysAgo(20).toISOString(),
        },
      ],
      { dryRun: false }
    );

    // The reveal is now blocked before any credit is spent on it.
    expect(await isEmailSuppressed(ORG, [BRAND_A], "emailed@casco.com")).toBe(
      true
    );
  });
});

describe("revertSentSuppressionBackfill", () => {
  const entry = (sentAt: Date) => ({
    orgId: ORG,
    brandId: BRAND_A,
    email: "emailed@casco.com",
    sentAt: sentAt.toISOString(),
  });

  it("dry-run reports what it would remove and writes nothing", async () => {
    await backfillSentSuppressions(REASON, [entry(daysAgo(30))], {
      dryRun: false,
    });

    const result = await revertSentSuppressionBackfill(REASON, { dryRun: true });
    expect(result.ledgerRows).toBe(1);
    expect(result.wouldRemove).toBe(1);
    expect(result.removed).toBe(0);
    expect(await db.select().from(brandSuppressions)).toHaveLength(1);
    expect(await db.select().from(suppressionBackfills)).toHaveLength(1);
  });

  it("removes exactly the rows this reason created and drops the ledger", async () => {
    await recordServe(ORG, [BRAND_B], [contact({ email: "real@casco.com" })]);
    await backfillSentSuppressions(REASON, [entry(daysAgo(30))], {
      dryRun: false,
    });

    const result = await revertSentSuppressionBackfill(REASON, {
      dryRun: false,
    });
    expect(result.removed).toBe(1);

    const left = await db.select().from(brandSuppressions);
    expect(left).toHaveLength(1);
    expect(left[0].emailNorm).toBe("real@casco.com");
    expect(await db.select().from(suppressionBackfills)).toHaveLength(0);
  });

  it("keeps a backfilled row that has been re-served since", async () => {
    await backfillSentSuppressions(REASON, [entry(daysAgo(30))], {
      dryRun: false,
    });
    // A genuine serve lands on the same person: last_served_at moves.
    await recordServe(ORG, [BRAND_A], [contact({ email: "emailed@casco.com" })]);

    const result = await revertSentSuppressionBackfill(REASON, {
      dryRun: false,
    });
    expect(result.removed).toBe(0);
    expect(result.skippedReserved).toBe(1);

    // The real emission is preserved; only the ledger is cleared.
    expect(await isEmailSuppressed(ORG, [BRAND_A], "emailed@casco.com")).toBe(
      true
    );
    expect(await db.select().from(suppressionBackfills)).toHaveLength(0);
  });
});

describe("POST /internal/backfill-sent-suppressions", () => {
  it("requires service auth", async () => {
    const res = await request(app)
      .post("/internal/backfill-sent-suppressions")
      .send({ reason: REASON, entries: [] });
    expect(res.status).toBe(401);
  });

  it("400s on an entry missing its send time", async () => {
    const res = await request(app)
      .post("/internal/backfill-sent-suppressions")
      .set(getAuthHeaders())
      .send({
        reason: REASON,
        entries: [{ orgId: ORG, brandId: BRAND_A, email: "a@b.com" }],
      });
    expect(res.status).toBe(400);
  });

  it("dry-runs, then applies, then reverts over HTTP", async () => {
    const body = {
      reason: REASON,
      entries: [
        {
          orgId: ORG,
          brandId: BRAND_A,
          email: "emailed@casco.com",
          sentAt: daysAgo(30).toISOString(),
        },
      ],
    };

    const dry = await request(app)
      .post("/internal/backfill-sent-suppressions?dryRun=true")
      .set(getAuthHeaders())
      .send(body);
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.wouldBackfill).toBe(1);
    expect(dry.body.wouldSuppressNow).toBe(1);
    expect(await db.select().from(brandSuppressions)).toHaveLength(0);

    const run = await request(app)
      .post("/internal/backfill-sent-suppressions")
      .set(getAuthHeaders())
      .send(body);
    expect(run.status).toBe(200);
    expect(run.body.backfilled).toBe(1);
    expect(await db.select().from(brandSuppressions)).toHaveLength(1);

    const revert = await request(app)
      .post("/internal/backfill-sent-suppressions/revert")
      .set(getAuthHeaders())
      .send({ reason: REASON });
    expect(revert.status).toBe(200);
    expect(revert.body.removed).toBe(1);
    expect(await db.select().from(brandSuppressions)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(suppressionBackfills)
        .where(eq(suppressionBackfills.reason, REASON))
    ).toHaveLength(0);
  });
});
