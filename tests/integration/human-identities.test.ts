import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { people } from "../../src/db/schema.js";
import { resolvePersonId } from "../../src/services/audience-provenance.js";
import { linkPeopleToHumans } from "../../src/services/human-identity-people.js";
import type { ServedContact } from "../../src/services/suppression.js";

// ONE HUMAN ACROSS THE FLEET (LEAD-REFONTE-1013): one id per real human whatever
// org asks; a shared email/phone merges fleet-wide, a judgment merges for one org.
const app = createTestApp();
const H = getAuthHeaders();
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000a2";
const LUCAS = "hello@obra.cam";

function resolve(body: Record<string, unknown>) {
  return request(app)
    .post("/internal/human-identities/resolve")
    .set(H)
    .send({ source: "test", create: true, ...body });
}
const view = (humanId: string, orgId?: string) =>
  request(app).get(`/internal/human-identities/${humanId}${orgId ? `?orgId=${orgId}` : ""}`).set(H);
const link = (body: Record<string, unknown>) =>
  request(app)
    .post("/internal/human-identities/links")
    .set(H)
    .send({ judgedBy: "person:u1", statedBy: "test", evidence: "same name, same company", ...body });

beforeEach(async () => {
  await cleanTestData();
});
afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("resolve", () => {
  it("the same email from two orgs is ONE human", async () => {
    const before = await resolve({ orgId: ORG_A, emails: [LUCAS], create: false });
    expect(before.status).toBe(200);
    expect(before.body.humanId).toBeNull();

    const a = await resolve({ orgId: ORG_A, emails: [" Hello@Obra.cam "] });
    expect(a.status).toBe(200);
    expect(a.body.created).toBe(true);
    const b = await resolve({ orgId: ORG_B, emails: [LUCAS] });
    expect(b.body.created).toBe(false);
    expect(b.body.humanId).toBe(a.body.humanId);

    const v = await view(a.body.humanId);
    expect(v.status).toBe(200);
    expect(v.body.emails).toEqual([LUCAS]);
  });

  it("refuses a phone that is not E.164, and a call with no key", async () => {
    expect((await resolve({ phones: ["0612345678"] })).status).toBe(400);
    expect((await resolve({})).status).toBe(400);
  });

  it("a shared email or phone merges two humans fleet-wide; the oldest names it", async () => {
    const h1 = (await resolve({ emails: [LUCAS] })).body.humanId;
    const h2 = (await resolve({ phones: ["+33 6 12 34 56 78"] })).body.humanId;
    expect(h2).not.toBe(h1);

    const merged = await resolve({ orgId: ORG_B, emails: [LUCAS], phones: ["+33612345678"] });
    expect(merged.body.humanId).toBe(h1);
    expect(merged.body.mergedHumanIds).toEqual([h2]);

    // Every org sees it, and the merged-away id answers with the human it is now.
    for (const org of [ORG_A, ORG_B, undefined]) {
      const v = await view(h2, org);
      expect(v.body.humanId).toBe(h1);
      expect(v.body.memberHumanIds.sort()).toEqual([h1, h2].sort());
      expect(v.body.phones).toEqual(["+33612345678"]);
    }
    const events = await request(app).get(`/internal/human-identities/events?orgId=${ORG_A}`).set(H);
    const linked = events.body.events.filter((e: { type: string }) => e.type === "human.linked");
    expect(linked).toHaveLength(1);
    expect(linked[0].orgId).toBeNull();
    expect(linked[0].data.basis).toBe("shared_phone");
  });

  it("a LinkedIn URL or provider id held by another human resolves, never merges", async () => {
    const h1 = (await resolve({ emails: [LUCAS] })).body.humanId;
    const h2 = (await resolve({ linkedinUrls: ["https://www.linkedin.com/in/lucas/"] })).body.humanId;
    const r = await resolve({ emails: [LUCAS], linkedinUrls: ["linkedin.com/in/lucas"] });
    expect(r.body.humanId).toBe(h1);
    expect(r.body.mergedHumanIds).toEqual([]);
    expect((await view(h2)).body.humanId).toBe(h2);
  });
});

describe("merge and split statements", () => {
  it("a judgment merge holds only for the org that stated it; a fleet one is refused", async () => {
    const h1 = (await resolve({ emails: [LUCAS] })).body.humanId;
    const h3 = (await resolve({ emails: ["lucas.martinez@gmail.com"] })).body.humanId;

    expect((await link({ relation: "same", humanIds: [h1, h3] })).status).toBe(400);

    const r = await link({ orgId: ORG_A, relation: "same", humanIds: [h3, h1] });
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);
    expect(r.body.humanIds).toEqual([h1]);
    expect(r.body.link.scope).toBe("org");

    expect((await view(h3, ORG_A)).body.humanId).toBe(h1);
    expect((await view(h3, ORG_B)).body.humanId).toBe(h3);
    expect((await view(h3)).body.humanId).toBe(h3);
    expect((await resolve({ orgId: ORG_A, emails: ["lucas.martinez@gmail.com"], create: false })).body.humanId).toBe(h1);
    expect((await resolve({ orgId: ORG_B, emails: ["lucas.martinez@gmail.com"], create: false })).body.humanId).toBe(h3);

    // The org's event reaches that org only.
    const evB = await request(app).get(`/internal/human-identities/events?orgId=${ORG_B}`).set(H);
    expect(evB.body.events.some((e: { type: string }) => e.type === "human.linked")).toBe(false);
    const evA = await request(app).get(`/internal/human-identities/events?orgId=${ORG_A}`).set(H);
    expect(evA.body.events.some((e: { type: string; orgId: string }) => e.type === "human.linked" && e.orgId === ORG_A)).toBe(true);

    // Idempotent restatement, then withdraw = undo.
    expect((await link({ orgId: ORG_A, relation: "same", humanIds: [h1, h3] })).body.changed).toBe(false);
    const wrong = await request(app)
      .post(`/internal/human-identities/links/${r.body.link.linkId}/withdraw`)
      .set(H)
      .send({ orgId: ORG_B, withdrawnBy: "u2", reason: "not mine" });
    expect(wrong.status).toBe(404);
    const w = await request(app)
      .post(`/internal/human-identities/links/${r.body.link.linkId}/withdraw`)
      .set(H)
      .send({ orgId: ORG_A, withdrawnBy: "u1", reason: "mistake" });
    expect(w.status).toBe(200);
    expect(w.body.changed).toBe(true);
    expect((await view(h3, ORG_A)).body.humanId).toBe(h3);
  });

  it("a fleet split separates a proven merge and blocks an automatic re-merge until withdrawn", async () => {
    const h1 = (await resolve({ emails: [LUCAS] })).body.humanId;
    const h2 = (await resolve({ phones: ["+33612345678"] })).body.humanId;
    await resolve({ emails: [LUCAS], phones: ["+33612345678"] });

    const split = await link({ relation: "distinct", humanIds: [h1, h2], evidence: "family phone" });
    expect(split.status).toBe(200);
    expect(split.body.humanIds.sort()).toEqual([h1, h2].sort());
    expect((await view(h2)).body.humanId).toBe(h2);

    const again = await resolve({ emails: [LUCAS], phones: ["+33612345678"] });
    expect(again.body.mergedHumanIds).toEqual([]);
    expect(again.body.separatedHumanIds).toEqual([h2]);
    expect((await view(h2)).body.humanId).toBe(h2);

    await request(app)
      .post(`/internal/human-identities/links/${split.body.link.linkId}/withdraw`)
      .set(H)
      .send({ withdrawnBy: "staff", reason: "they are the same" });
    expect((await view(h2)).body.humanId).toBe(h1);
  });

  it("an org split of a fleet merge holds for that org only", async () => {
    const h1 = (await resolve({ emails: [LUCAS] })).body.humanId;
    const h2 = (await resolve({ phones: ["+33612345678"] })).body.humanId;
    await resolve({ emails: [LUCAS], phones: ["+33612345678"] });
    const split = await link({ orgId: ORG_A, relation: "distinct", humanIds: [h1, h2] });
    expect(split.status).toBe(200);
    expect((await view(h2, ORG_A)).body.humanId).toBe(h2);
    expect((await view(h2, ORG_B)).body.humanId).toBe(h1);
  });

  it("a split that leaves them one human through other links is a 409, nothing written", async () => {
    const h1 = (await resolve({ emails: [LUCAS] })).body.humanId;
    const h2 = (await resolve({ phones: ["+33612345678"] })).body.humanId;
    const h3 = (await resolve({ phones: ["+33700000000"] })).body.humanId;
    // Org A judged h1 = h3 = h2 before the proof merge of h1 and h2 landed.
    expect((await link({ orgId: ORG_A, relation: "same", humanIds: [h1, h3] })).body.changed).toBe(true);
    expect((await link({ orgId: ORG_A, relation: "same", humanIds: [h3, h2] })).body.changed).toBe(true);
    await resolve({ emails: [LUCAS], phones: ["+33612345678"] });
    const r = await link({ orgId: ORG_A, relation: "distinct", humanIds: [h1, h2] });
    expect(r.status).toBe(409);
    expect((await view(h2, ORG_A)).body.humanId).toBe(h1);
  });
});

describe("facts on the human", () => {
  it("an opt-out stated on one atomic human is read on the merged human, and withdrawable", async () => {
    const h1 = (await resolve({ emails: [LUCAS] })).body.humanId;
    const h2 = (await resolve({ phones: ["+33612345678"] })).body.humanId;
    const f = await request(app)
      .post(`/internal/human-identities/${h2}/facts`)
      .set(H)
      .send({ kind: "opt_out", statedByOrgId: ORG_B, source: "instantly-service", evidence: "replied stop" });
    expect(f.status).toBe(200);
    await resolve({ emails: [LUCAS], phones: ["+33612345678"] });
    const v = await view(h1, ORG_A);
    expect(v.body.facts).toHaveLength(1);
    expect(v.body.facts[0]).toMatchObject({ kind: "opt_out", statedByOrgId: ORG_B, humanId: h2 });

    const w = await request(app)
      .post(`/internal/human-identities/facts/${f.body.fact.factId}/withdraw`)
      .set(H)
      .send({ withdrawnBy: "instantly-service", reason: "asked to hear from us again" });
    expect(w.body.changed).toBe(true);
    expect((await view(h1)).body.facts).toEqual([]);
    expect(
      (await request(app).post(`/internal/human-identities/00000000-0000-4000-8000-000000000999/facts`).set(H).send({
        kind: "opt_out",
        source: "x",
        evidence: "y",
      })).status
    ).toBe(404);
  });
});

describe("per-org people hang off the human", () => {
  function contact(email: string, extra: Partial<ServedContact> = {}): ServedContact {
    return {
      email,
      linkedinUrl: null,
      firstName: "Lucas",
      lastName: "Martinez",
      companyDomain: "obra.cam",
      provider: "apollo",
      providerPersonId: null,
      ...extra,
    };
  }

  it("links every person, same email across orgs = same human; an attached address is the org's judgment", async () => {
    const pa = await db.transaction((tx) => resolvePersonId(tx, ORG_A, contact(LUCAS, { providerPersonId: "apl-1" })));
    const pb = await db.transaction((tx) => resolvePersonId(tx, ORG_B, contact(LUCAS)));
    const teaser = await db.transaction((tx) =>
      resolvePersonId(tx, ORG_B, contact("", { email: null, providerPersonId: "apl-2" }))
    );
    // Org A states Lucas also writes from his gmail.
    const att = await request(app)
      .post(`/internal/people/${pa}/emails`)
      .set(H)
      .send({ orgId: ORG_A, email: "lucas.martinez@gmail.com", evidence: "replied from it", attachedBy: "staff:kevin" });
    expect(att.status).toBe(200);

    const dry = await linkPeopleToHumans({ dryRun: true });
    expect(dry.linkedPeople).toBe(3);

    const r = await linkPeopleToHumans({ dryRun: false });
    expect(r).toMatchObject({ linkedPeople: 3, orgLinks: 1, hasMore: false });

    const rows = await db.select().from(people);
    const byId = new Map(rows.map((p) => [p.id, p]));
    expect(byId.get(pa)!.humanId).toBe(byId.get(pb)!.humanId);
    expect(byId.get(teaser)!.humanId).not.toBe(byId.get(pa)!.humanId);

    const human = (await resolve({ emails: [LUCAS], create: false })).body.humanId;
    const pv = await request(app).get(`/internal/people/${pb}?orgId=${ORG_B}`).set(H);
    expect(pv.body.humanId).toBe(human);

    // The gmail is Lucas for org A only.
    expect((await resolve({ orgId: ORG_A, emails: ["lucas.martinez@gmail.com"], create: false })).body.humanId).toBe(human);
    expect((await resolve({ orgId: ORG_B, emails: ["lucas.martinez@gmail.com"], create: false })).body.humanId).not.toBe(human);
    const va = await view(human, ORG_A);
    expect(va.body.emails.sort()).toEqual([LUCAS, "lucas.martinez@gmail.com"].sort());
    expect(va.body.people).toEqual([{ orgId: ORG_A, personId: pa }]);
    expect((await view(human, ORG_B)).body.emails).toEqual([LUCAS]);

    // Idempotent; a new served address is picked up on the next run.
    expect(await linkPeopleToHumans({ dryRun: false })).toMatchObject({ linkedPeople: 0, revisitedPeople: 0 });
    await db.transaction((tx) => resolvePersonId(tx, ORG_B, contact("lucas@newco.io", { providerPersonId: null, linkedinUrl: null })));
    const pNew = (await db.select().from(people).where(eq(people.emailNorm, "lucas@newco.io")))[0];
    expect(pNew.humanId).toBeNull();
    await linkPeopleToHumans({ dryRun: false });
    const after = (await db.select().from(people).where(eq(people.id, pNew.id)))[0];
    expect(after.humanId).not.toBeNull();
  });
});

describe("messaging handles (RELATIONSHIP-TAGS-1014)", () => {
  const YULIA_LID = { network: "whatsapp", id: "83932385144839@lid" };
  const YULIIA = "lusenko.julija@gmail.com";

  it("a WhatsApp handle with no phone resolves to a human, and resolves again to the same one", async () => {
    const miss = await resolve({ orgId: ORG_A, messagingHandles: [YULIA_LID], create: false });
    expect(miss.status).toBe(200);
    expect(miss.body.humanId).toBeNull();

    const a = await resolve({ orgId: ORG_A, messagingHandles: [YULIA_LID] });
    expect(a.status).toBe(200);
    expect(a.body.created).toBe(true);
    const again = await resolve({ orgId: ORG_B, messagingHandles: [{ network: "whatsapp", id: " 83932385144839@lid " }] });
    expect(again.body.created).toBe(false);
    expect(again.body.humanId).toBe(a.body.humanId);

    const v = await view(a.body.humanId, ORG_A);
    expect(v.body.messagingHandles).toEqual([YULIA_LID]);
    expect(v.body.emails).toEqual([]);
  });

  it("a handle never merges by itself; an org judgment link makes one human in that org only, and is undoable", async () => {
    const yuliia = await resolve({ orgId: ORG_A, emails: [YULIIA] });
    const ghost = await resolve({ orgId: ORG_A, messagingHandles: [YULIA_LID] });
    expect(ghost.body.humanId).not.toBe(yuliia.body.humanId);

    // The handle given beside her email on one contact: it is already held, so it
    // stays with the ghost human: no automatic merge.
    const both = await resolve({ orgId: ORG_A, emails: [YULIIA], messagingHandles: [YULIA_LID] });
    expect(both.body.humanId).toBe(yuliia.body.humanId);
    expect(both.body.mergedHumanIds).toEqual([]);
    const stillGhost = await resolve({ orgId: ORG_A, messagingHandles: [YULIA_LID], create: false });
    expect(stillGhost.body.humanId).toBe(ghost.body.humanId);

    const merged = await link({ orgId: ORG_A, relation: "same", humanIds: [yuliia.body.humanId, ghost.body.humanId] });
    expect(merged.status).toBe(200);
    expect(merged.body.changed).toBe(true);
    const inA = await resolve({ orgId: ORG_A, messagingHandles: [YULIA_LID], create: false });
    const inB = await resolve({ orgId: ORG_B, messagingHandles: [YULIA_LID], create: false });
    expect(inA.body.humanId).toBe(merged.body.humanIds[0]);
    expect(inA.body.humanId).toBe(
      (await resolve({ orgId: ORG_A, emails: [YULIIA], create: false })).body.humanId
    );
    // Org B never stated the merge: there they stay two humans.
    expect(inB.body.humanId).toBe(ghost.body.humanId);
    expect((await resolve({ orgId: ORG_B, emails: [YULIIA], create: false })).body.humanId).toBe(yuliia.body.humanId);
    const vA = await view(inA.body.humanId, ORG_A);
    expect(vA.body.emails).toEqual([YULIIA]);
    expect(vA.body.messagingHandles).toEqual([YULIA_LID]);

    const undo = await request(app)
      .post(`/internal/human-identities/links/${merged.body.link.linkId}/withdraw`)
      .set(H)
      .send({ orgId: ORG_A, withdrawnBy: "person:u1", reason: "not her" });
    expect(undo.status).toBe(200);
    const after = await resolve({ orgId: ORG_A, messagingHandles: [YULIA_LID], create: false });
    expect(after.body.humanId).toBe(ghost.body.humanId);
  });

  it("400 on an unknown network or a blank id", async () => {
    expect((await resolve({ messagingHandles: [{ network: "fax", id: "1" }] })).status).toBe(400);
    expect((await resolve({ messagingHandles: [{ network: "whatsapp", id: "   " }] })).status).toBe(400);
  });
});

describe("CRM record keys (HUMAN-RECORD-KEYS-1017)", () => {
  const GHL = { provider: "gohighlevel", accountId: "locDocDinners", id: "pVk2bD1sQx8yZ3mR7tLw" };
  const MARIE = "marie@example.com";

  it("a record with no email or phone gets a human, and the same record again is the same human", async () => {
    const miss = await resolve({ orgId: ORG_A, crmRecords: [GHL], create: false });
    expect(miss.status).toBe(200);
    expect(miss.body.humanId).toBeNull();

    const a = await resolve({ orgId: ORG_A, source: "crm-service", crmRecords: [GHL] });
    expect(a.status).toBe(200);
    expect(a.body.created).toBe(true);
    const again = await resolve({ orgId: ORG_A, crmRecords: [{ ...GHL, id: ` ${GHL.id} ` }] });
    expect(again.body.created).toBe(false);
    expect(again.body.humanId).toBe(a.body.humanId);

    const v = await view(a.body.humanId, ORG_A);
    expect(v.body.crmRecords).toEqual([GHL]);
    expect(v.body.emails).toEqual([]);

    // The event feed carries the key the way it carries every other key.
    const feed = await request(app).get("/internal/human-identities/events").set(H);
    const created = feed.body.events.find(
      (e: { type: string; humanIds: string[] }) => e.type === "human.created" && e.humanIds.includes(a.body.atomicHumanId)
    );
    expect(created.data.keys).toEqual([
      { kind: "crm_record", valueNorm: `gohighlevel:${GHL.accountId}:${GHL.id}` },
    ]);
  });

  it("the same record id in two client accounts (or two tools) is two humans", async () => {
    const a = await resolve({ crmRecords: [GHL] });
    const otherAccount = await resolve({ crmRecords: [{ ...GHL, accountId: "locOtherClient" }] });
    const otherTool = await resolve({ crmRecords: [{ ...GHL, provider: "stripe" }] });
    expect(new Set([a.body.humanId, otherAccount.body.humanId, otherTool.body.humanId]).size).toBe(3);
  });

  it("a record never merges by itself; an org judgment link joins it in that org only", async () => {
    const marie = await resolve({ orgId: ORG_A, emails: [MARIE] });
    const record = await resolve({ orgId: ORG_A, crmRecords: [GHL] });
    expect(record.body.humanId).not.toBe(marie.body.humanId);

    // Given beside her email, the record is already held: it stays where it is.
    const both = await resolve({ orgId: ORG_A, emails: [MARIE], crmRecords: [GHL] });
    expect(both.body.humanId).toBe(marie.body.humanId);
    expect(both.body.mergedHumanIds).toEqual([]);
    expect((await resolve({ orgId: ORG_A, crmRecords: [GHL], create: false })).body.humanId).toBe(record.body.humanId);

    const merged = await link({ orgId: ORG_A, relation: "same", humanIds: [marie.body.humanId, record.body.humanId] });
    expect(merged.status).toBe(200);
    const inA = await resolve({ orgId: ORG_A, crmRecords: [GHL], create: false });
    expect(inA.body.humanId).toBe((await resolve({ orgId: ORG_A, emails: [MARIE], create: false })).body.humanId);
    expect((await resolve({ orgId: ORG_B, crmRecords: [GHL], create: false })).body.humanId).toBe(record.body.humanId);
    const vA = await view(inA.body.humanId, ORG_A);
    expect(vA.body.emails).toEqual([MARIE]);
    expect(vA.body.crmRecords).toEqual([GHL]);
  });

  it("400 on an unknown provider, a blank id, or an accountId holding ':'", async () => {
    expect((await resolve({ crmRecords: [{ ...GHL, provider: "salesforce" }] })).status).toBe(400);
    expect((await resolve({ crmRecords: [{ ...GHL, id: "   " }] })).status).toBe(400);
    expect((await resolve({ crmRecords: [{ ...GHL, accountId: "  " }] })).status).toBe(400);
    expect((await resolve({ crmRecords: [{ ...GHL, accountId: "a:b" }] })).status).toBe(400);
  });
});
