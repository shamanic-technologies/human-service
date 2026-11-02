import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { audiences } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { ProviderError } from "../../src/services/people-providers.js";

// QE-CHIRO-1102: PATCH /orgs/audiences/:id/serve-source. apollo-service owns the
// switch; these tests pin what human-service sends it and what it stores.
const createApollo = vi.fn();
const setServe = vi.fn();
vi.mock("../../src/lib/apollo-audiences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/apollo-audiences.js")>()),
  createApolloAudienceFromFilters: (...a: unknown[]) => createApollo(...a),
  setApolloServeSource: (...a: unknown[]) => setServe(...a),
}));

const app = createTestApp();
const ORG = "a0000000-0000-4000-8000-000000000001";
const OTHER_ORG = "a0000000-0000-4000-8000-000000000002";
const BRAND = "b0000000-0000-4000-8000-00000000000a";
const USER = "c0000000-0000-4000-8000-000000000001";
const headers = { "X-API-Key": "test-api-key", "Content-Type": "application/json", "x-org-id": ORG, "x-user-id": USER };
const TITLES = { person_titles: ["Chiropractor", "Doctor of Chiropractic", "Chiropractic Physician"], person_locations: ["United States"] };

async function seed(overrides: Partial<typeof audiences.$inferInsert> = {}) {
  const [row] = await db
    .insert(audiences)
    .values({ orgId: ORG, brandId: BRAND, name: `aud-${Math.random().toString(36).slice(2)}`, provider: "apollo", filters: TITLES, nlPrompt: "Chiropractors in the US", ...overrides })
    .returning();
  return row;
}

const switched = (id: string, serveSource = "quickenrich") => ({ apolloAudienceId: id, serveSource, quickenrich: { expressible: true, reasons: [] } });

beforeEach(async () => {
  await cleanTestData();
  createApollo.mockReset();
  setServe.mockReset();
});

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("PATCH /orgs/audiences/:id/serve-source", () => {
  it("an audience with no apollo record gets one from its stored filters, verbatim, then is switched", async () => {
    const aud = await seed();
    createApollo.mockResolvedValue({ ...switched("apollo-aud-1", "apollo"), count: 5657 });
    setServe.mockResolvedValue(switched("apollo-aud-1"));

    const res = await request(app).patch(`/orgs/audiences/${aud.id}/serve-source`).set(headers).send({ serveSource: "quickenrich" });

    expect(res.status).toBe(200);
    expect(res.body.serveSource).toBe("quickenrich");
    expect(res.body.quickenrich.expressible).toBe(true);
    expect(createApollo).toHaveBeenCalledWith(expect.objectContaining({ filters: TITLES, brandId: BRAND, name: aud.name }));
    expect(setServe).toHaveBeenCalledWith("apollo-aud-1", "quickenrich", expect.objectContaining({ orgId: ORG, userId: USER }));
    const [row] = await db.select().from(audiences).where(eq(audiences.id, aud.id));
    expect(row.apolloAudienceId).toBe("apollo-aud-1");
    expect(row.apolloCount).toBe(5657);
    expect(row.filters).toEqual(TITLES);
  });

  it("an audience that already has its apollo record is switched without a new one", async () => {
    const aud = await seed({ apolloAudienceId: "existing-1" });
    setServe.mockResolvedValue(switched("existing-1"));
    const res = await request(app).patch(`/orgs/audiences/${aud.id}/serve-source`).set(headers).send({ serveSource: "quickenrich" });
    expect(res.status).toBe(200);
    expect(createApollo).not.toHaveBeenCalled();
    expect(setServe).toHaveBeenCalledWith("existing-1", "quickenrich", expect.anything());
  });

  it("relays apollo-service's 422 with every reason", async () => {
    const aud = await seed({ apolloAudienceId: "existing-2" });
    setServe.mockRejectedValue(
      new ProviderError("apollo", 422, JSON.stringify({ type: "not_expressible", error: "QuickEnrich cannot enforce this audience's filters faithfully", reasons: ["q_organization_keyword_tags: not expressible"] }))
    );
    const res = await request(app).patch(`/orgs/audiences/${aud.id}/serve-source`).set(headers).send({ serveSource: "quickenrich" });
    expect(res.status).toBe(422);
    expect(res.body.reasons).toEqual(["q_organization_keyword_tags: not expressible"]);
  });

  it("refuses a non-apollo audience, another org's audience and a bad body", async () => {
    const crm = await seed({ provider: "crm", filters: null });
    expect((await request(app).patch(`/orgs/audiences/${crm.id}/serve-source`).set(headers).send({ serveSource: "quickenrich" })).status).toBe(400);
    const foreign = await seed({ orgId: OTHER_ORG });
    expect((await request(app).patch(`/orgs/audiences/${foreign.id}/serve-source`).set(headers).send({ serveSource: "quickenrich" })).status).toBe(404);
    const aud = await seed();
    expect((await request(app).patch(`/orgs/audiences/${aud.id}/serve-source`).set(headers).send({ serveSource: "x" })).status).toBe(400);
    expect(createApollo).not.toHaveBeenCalled();
    expect(setServe).not.toHaveBeenCalled();
  });
});
