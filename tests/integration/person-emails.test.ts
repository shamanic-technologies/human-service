import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// ONE PERSON, SEVERAL ADDRESSES: a person keeps every address they write from,
// a lookup by any of them answers the same person id, and a per-brand
// suppression / opt-out stated on one address holds for the person.
vi.mock("../../src/lib/instantly-optouts.js", () => ({
  listStandingOptOutEmails: vi.fn(async () => []),
  isEmailOptedOut: vi.fn(async () => false),
  OptOutSourceError: class OptOutSourceError extends Error {},
  OptOutConfigError: class OptOutConfigError extends Error {},
}));
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audienceMembers, audiences, people } from "../../src/db/schema.js";
import { resolvePersonId } from "../../src/services/audience-provenance.js";
import {
  claimServe,
  isEmailSuppressed,
  recordServe,
  type ServedContact,
} from "../../src/services/suppression.js";
import { loadOptOutExclusions, isPersonOptedOut } from "../../src/services/opt-outs.js";
import * as optOutsLib from "../../src/lib/instantly-optouts.js";
import { transferBrand } from "../../src/services/transfer-brand.js";

const app = createTestApp();
const ORG = getAuthHeaders()["x-org-id"];
const OTHER_ORG = "00000000-0000-4000-8000-0000000000f9";
const BRAND = "00000000-0000-4000-8000-0000000000b1";
const OTHER_BRAND = "00000000-0000-4000-8000-0000000000b2";
const WORK = "stacy.blecher@twinhealth.com";
const OWN = "drblecher@chsmetabolismdoc.com";
const identity = { orgId: ORG, userId: getAuthHeaders()["x-user-id"], brandIds: [BRAND] };

function contact(email: string, extra: Partial<ServedContact> = {}): ServedContact {
  return {
    email,
    linkedinUrl: null,
    firstName: "Stacy",
    lastName: "Blecher",
    companyDomain: email.split("@")[1],
    provider: "apollo",
    providerPersonId: null,
    ...extra,
  };
}

async function servedPerson(): Promise<string> {
  return db.transaction((tx) =>
    resolvePersonId(tx, ORG, contact(WORK, { providerPersonId: "apollo-stacy" }))
  );
}

function attach(personId: string, email: string, orgId = ORG) {
  return request(app)
    .post(`/internal/people/${personId}/emails`)
    .set(getAuthHeaders())
    .send({
      orgId,
      email,
      companyDomain: "chsmetabolismdoc.com",
      companyName: "MALI",
      evidence: "replied from it to the email we sent to her work address",
      attachedBy: "test",
    });
}

beforeEach(async () => {
  await cleanTestData();
  vi.mocked(optOutsLib.listStandingOptOutEmails).mockResolvedValue([]);
  vi.mocked(optOutsLib.isEmailOptedOut).mockResolvedValue(false);
});

afterAll(async () => {
  await closeDb();
});

describe("attach + lookup", () => {
  it("a lookup by EITHER address returns the same person, holding both", async () => {
    const personId = await servedPerson();
    const res = await attach(personId, OWN.toUpperCase());
    expect(res.status).toBe(200);
    expect(res.body.attached).toBe(true);
    expect(res.body.person.emails.map((e: { email: string }) => e.email)).toEqual([WORK, OWN]);
    expect(res.body.person.emails[0]).toMatchObject({ primary: true, source: "served" });
    expect(res.body.person.emails[1]).toMatchObject({
      primary: false,
      source: "attached",
      companyDomain: "chsmetabolismdoc.com",
      companyName: "MALI",
    });

    for (const email of [WORK, OWN, ` ${OWN.toUpperCase()} `]) {
      const found = await request(app)
        .get(`/internal/people/by-email`)
        .query({ orgId: ORG, email })
        .set(getAuthHeaders());
      expect(found.status).toBe(200);
      expect(found.body.person.personId).toBe(personId);
      expect(found.body.person.primaryEmail).toBe(WORK);
      expect(found.body.person.emails).toHaveLength(2);
    }

    const byId = await request(app)
      .get(`/internal/people/${personId}`)
      .query({ orgId: ORG })
      .set(getAuthHeaders());
    expect(byId.status).toBe(200);
    expect(byId.body.emails).toHaveLength(2);
  });

  it("is org-scoped: another org finds nobody", async () => {
    const personId = await servedPerson();
    await attach(personId, OWN);
    const res = await request(app)
      .get(`/internal/people/by-email`)
      .query({ orgId: OTHER_ORG, email: OWN })
      .set(getAuthHeaders());
    expect(res.body.person).toBeNull();
    expect((await attach(personId, "x@y.com", OTHER_ORG)).status).toBe(404);
  });

  it("is idempotent, and never takes an address another person holds (409)", async () => {
    const personId = await servedPerson();
    expect((await attach(personId, OWN)).body.attached).toBe(true);
    const again = await attach(personId, OWN);
    expect(again.status).toBe(200);
    expect(again.body.attached).toBe(false);
    expect(again.body.person.emails).toHaveLength(2);

    const other = await db.transaction((tx) =>
      resolvePersonId(tx, ORG, contact("andrew@scoi.com", { firstName: "Andrew" }))
    );
    const taken = await attach(other, OWN);
    expect(taken.status).toBe(409);
    const primaryTaken = await attach(other, WORK);
    expect(primaryTaken.status).toBe(409);
  });

  it("a serve that reveals the person at the attached address resolves to them and keeps the primary", async () => {
    const personId = await servedPerson();
    await attach(personId, OWN);
    const again = await db.transaction((tx) => resolvePersonId(tx, ORG, contact(OWN)));
    expect(again).toBe(personId);
    const rows = await db.select().from(people);
    expect(rows).toHaveLength(1);
    expect(rows[0].emailNorm).toBe(WORK);
  });

  it("a person re-revealed at a new address by their provider id keeps the old address too", async () => {
    const personId = await servedPerson();
    const moved = await db.transaction((tx) =>
      resolvePersonId(tx, ORG, contact("stacy@newjob.com", { providerPersonId: "apollo-stacy" }))
    );
    expect(moved).toBe(personId);
    const found = await request(app)
      .get(`/internal/people/by-email`)
      .query({ orgId: ORG, email: WORK })
      .set(getAuthHeaders());
    expect(found.body.person.personId).toBe(personId);
    expect(found.body.person.emails.map((e: { email: string }) => e.email).sort()).toEqual(
      ["stacy@newjob.com", WORK].sort()
    );
  });
});

describe("facts on one address hold for the person", () => {
  it("served at the work address for a brand ⟹ suppressed at the other address too", async () => {
    const personId = await servedPerson();
    await attach(personId, OWN);
    await recordServe(ORG, [BRAND], [contact(WORK)]);

    expect(await isEmailSuppressed(ORG, [BRAND], OWN)).toBe(true);
    expect(await claimServe(ORG, [BRAND], contact(OWN))).toBe(false);
    // Another brand never served her: free.
    expect(await isEmailSuppressed(ORG, [OTHER_BRAND], OWN)).toBe(false);
    // An address of nobody we know stands for itself.
    expect(await isEmailSuppressed(ORG, [BRAND], "someone@else.com")).toBe(false);
  });

  it("without the attach, the two addresses are two people (nothing guessed)", async () => {
    await servedPerson();
    await recordServe(ORG, [BRAND], [contact(WORK)]);
    expect(await isEmailSuppressed(ORG, [BRAND], OWN)).toBe(false);
  });

  it("an opt-out stated on the other address excludes the person's pre-pay keys and every address", async () => {
    const personId = await servedPerson();
    await attach(personId, OWN);
    vi.mocked(optOutsLib.listStandingOptOutEmails).mockResolvedValue([OWN]);
    const ex = await loadOptOutExclusions(identity);
    expect(ex.personIds.has("apollo-stacy")).toBe(true);
    expect(ex.emails.has(WORK)).toBe(true);
    expect(ex.emails.has(OWN)).toBe(true);

    vi.mocked(optOutsLib.isEmailOptedOut).mockImplementation(async (_i, e) => e === OWN);
    expect(await isPersonOptedOut(identity, WORK)).toBe(true);
  });
});

describe("consumer reads list every address", () => {
  it("memberships by-email (either address) and audience members carry both", async () => {
    const personId = await servedPerson();
    await attach(personId, OWN);
    const [aud] = await db
      .insert(audiences)
      .values({ orgId: ORG, brandId: BRAND, name: "Docs", provider: "apollo", filters: {} })
      .returning();
    await db.insert(audienceMembers).values({
      orgId: ORG,
      audienceId: aud.id,
      personId,
      source: "apollo",
      confidence: "provider_confirmed",
    });

    const byEmail = await request(app)
      .post(`/internal/brands/${BRAND}/memberships/by-email`)
      .set(getAuthHeaders())
      .send({ orgId: ORG, emails: [OWN, WORK] });
    expect(byEmail.status).toBe(200);
    for (const e of [OWN, WORK]) {
      expect(byEmail.body.byEmail[e].personId).toBe(personId);
      expect(byEmail.body.byEmail[e].emails.map((x: { email: string }) => x.email)).toEqual([WORK, OWN]);
      expect(byEmail.body.byEmail[e].memberships).toHaveLength(1);
    }

    const page = await request(app)
      .get(`/internal/brands/${BRAND}/memberships`)
      .query({ orgId: ORG })
      .set(getAuthHeaders());
    expect(page.body.people[0].emails).toHaveLength(2);

    const members = await request(app)
      .get(`/orgs/audiences/${aud.id}/members`)
      .set(getAuthHeaders());
    expect(members.status).toBe(200);
    expect(members.body.members[0].emailNorm).toBe(WORK);
    expect(members.body.members[0].emails).toHaveLength(2);

    const resolved = await request(app)
      .post(`/internal/audiences/resolve`)
      .set(getAuthHeaders())
      .send({ orgId: ORG, brandId: BRAND, emails: [OWN] });
    expect(resolved.body.byEmail[OWN]).toMatchObject({ id: aud.id });

    const stats = await request(app)
      .post(`/orgs/audiences/stats`)
      .set(getAuthHeaders())
      .send({ emails: [OWN] });
    expect(stats.status).toBe(200);
    expect(stats.body.matched[0].personId).toBe(personId);
    expect(stats.body.unmatched.emails).toEqual([]);
  });
});

describe("brand transfer", () => {
  it("a moved person keeps every address in the target org", async () => {
    const personId = await servedPerson();
    await attach(personId, OWN);
    const [aud] = await db
      .insert(audiences)
      .values({ orgId: ORG, brandId: BRAND, name: "Docs", provider: "apollo", filters: {} })
      .returning();
    await db.insert(audienceMembers).values({
      orgId: ORG,
      audienceId: aud.id,
      personId,
      source: "apollo",
      confidence: "provider_confirmed",
    });
    const result = await transferBrand({ sourceBrandId: BRAND, sourceOrgId: ORG, targetOrgId: OTHER_ORG });
    expect(result.updatedTables).toContainEqual({ tableName: "person_emails", count: 2 });

    const there = await request(app)
      .get(`/internal/people/by-email`)
      .query({ orgId: OTHER_ORG, email: OWN })
      .set(getAuthHeaders());
    expect(there.body.person.personId).toBe(personId);
    expect(there.body.person.emails).toHaveLength(2);
    const here = await request(app)
      .get(`/internal/people/by-email`)
      .query({ orgId: ORG, email: OWN })
      .set(getAuthHeaders());
    expect(here.body.person).toBeNull();
  });
});
