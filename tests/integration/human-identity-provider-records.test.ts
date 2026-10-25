import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { humanIdentityEvents } from "../../src/db/schema.js";
import {
  mergeOnProviderRecords,
  type RevealRecord,
} from "../../src/services/human-identity-provider-records.js";

// LEDGER-RESIDUAL-1025-HUMANS: a human known only by an Apollo person id and the
// human holding the email Apollo's own paid reveal returned for that id are one
// human, when the record is unambiguous.
const app = createTestApp();
const H = getAuthHeaders();

function resolve(body: Record<string, unknown>) {
  return request(app)
    .post("/internal/human-identities/resolve")
    .set(H)
    .send({ source: "test", create: true, ...body });
}
const apollo = (id: string) => ({ providerPersonIds: [{ provider: "apollo", id }] });

// A reader answering from a fixed set of (person id, email) reveal rows.
function reader(reveals: Array<[string, string]>) {
  return async (ids: string[]): Promise<RevealRecord> => {
    const emailsByPersonId = new Map<string, string[]>();
    const personIdsByEmail = new Map<string, string[]>();
    for (const [pid, email] of reveals) {
      if (ids.includes(pid)) emailsByPersonId.set(pid, [...new Set([...(emailsByPersonId.get(pid) ?? []), email])]);
    }
    const asked = new Set([...emailsByPersonId.values()].flat());
    for (const [pid, email] of reveals) {
      if (asked.has(email)) personIdsByEmail.set(email, [...new Set([...(personIdsByEmail.get(email) ?? []), pid])]);
    }
    return { emailsByPersonId, personIdsByEmail };
  };
}

beforeEach(async () => {
  await cleanTestData();
});
afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("merge on the provider's reveal record", () => {
  it("dry run counts, the real run merges through a fleet link + event, a replay merges nothing", async () => {
    const a = await resolve(apollo("p1"));
    const b = await resolve({ emails: ["m.kool@elvacenter.com"] });
    expect(a.body.humanId).not.toBe(b.body.humanId);
    const readRecords = reader([["p1", "m.kool@elvacenter.com"]]);

    const dry = await mergeOnProviderRecords({ dryRun: true, readRecords });
    expect(dry).toMatchObject({ examined: 1, merged: 1, alreadyOne: 0 });
    const stillTwo = await resolve({ ...apollo("p1"), create: false });
    expect(stillTwo.body.humanId).toBe(a.body.humanId);

    const eventsBefore = (await db.select().from(humanIdentityEvents)).length;
    const run = await mergeOnProviderRecords({ dryRun: false, readRecords });
    expect(run.merged).toBe(1);
    const events = (await db.select().from(humanIdentityEvents)).slice(eventsBefore);
    expect(events.map((e) => e.type)).toEqual(["human.linked"]);
    expect(events[0].orgId).toBeNull();
    expect(events[0].data).toMatchObject({ relation: "same", scope: "fleet", basis: "provider_record" });

    const byId = await resolve({ ...apollo("p1"), create: false });
    const byEmail = await resolve({ emails: ["m.kool@elvacenter.com"], create: false });
    expect(byId.body.humanId).toBe(byEmail.body.humanId);

    const replay = await mergeOnProviderRecords({ dryRun: false, readRecords });
    expect(replay).toMatchObject({ merged: 0, alreadyOne: 1 });
    expect((await db.select().from(humanIdentityEvents)).length).toBe(eventsBefore + 1);
  });

  it("refuses an ambiguous record and counts each reason", async () => {
    await resolve(apollo("several")); // id revealed with two addresses
    await resolve({ emails: ["one@x.com"] });
    await resolve(apollo("shared1")); // address revealed for two ids
    await resolve(apollo("shared2"));
    await resolve({ emails: ["info@shared.com"] });
    await resolve(apollo("other")); // address holder is another apollo person
    await resolve({ emails: ["boss@y.com"], ...apollo("someone-else") });
    await resolve(apollo("none")); // never revealed with an address
    await resolve(apollo("lonely")); // revealed address nobody here holds

    const r = await mergeOnProviderRecords({
      dryRun: false,
      readRecords: reader([
        ["several", "one@x.com"],
        ["several", "two@x.com"],
        ["shared1", "info@shared.com"],
        ["shared2", "info@shared.com"],
        ["other", "boss@y.com"],
        ["lonely", "nobody@z.com"],
      ]),
    });
    expect(r.merged).toBe(0);
    expect(r.refused).toMatchObject({
      id_revealed_several_addresses: 1,
      address_revealed_for_several_people: 2,
      address_holder_is_another_apollo_person: 1,
    });
    expect(r.noRevealedAddress).toBe(1);
    expect(r.addressUnknownHere).toBe(1);
    // "someone-else" holds an email, so it is not a candidate at all.
    expect(r.examined).toBe(6);
  });

  it("a fleet split keeps the two apart", async () => {
    const a = await resolve(apollo("p2"));
    const b = await resolve({ emails: ["kept@apart.com"] });
    const split = await request(app)
      .post("/internal/human-identities/links")
      .set(H)
      .send({ relation: "distinct", humanIds: [a.body.humanId, b.body.humanId], judgedBy: "staff:t", statedBy: "test", evidence: "two people" });
    expect(split.status).toBe(200);
    const r = await mergeOnProviderRecords({ dryRun: false, readRecords: reader([["p2", "kept@apart.com"]]) });
    expect(r).toMatchObject({ merged: 0, refused: { split_stated: 1 } });
  });

  it("the route answers 502 when apollo-service is not configured", async () => {
    const before = { url: process.env.APOLLO_SERVICE_URL, key: process.env.APOLLO_SERVICE_API_KEY };
    delete process.env.APOLLO_SERVICE_URL;
    await resolve(apollo("p3"));
    const res = await request(app).post("/internal/human-identities/merge-provider-records?dryRun=true").set(H);
    expect(res.status).toBe(502);
    process.env.APOLLO_SERVICE_URL = before.url;
    process.env.APOLLO_SERVICE_API_KEY = before.key;
  });
});
