import { describe, it, expect } from "vitest";
import {
  AudienceSchema,
  CreateAudienceRequestSchema,
  ListAudiencesQuerySchema,
  UpdateAudienceRequestSchema,
} from "../../src/schemas.js";

// The wire contract for the offer scope (Org > Brand > Offer > Campaign).
// brand-service owns the entity; human-service only records the id, so the only
// thing to pin here is the SHAPE — the field name the dashboard must send, that
// it is optional everywhere (an absent offer is the pre-offer world), and that
// PATCH refuses it (set at creation, immutable afterwards).

const OFFER = "00000000-0000-4000-8000-0000000000e1";
const BRAND = "00000000-0000-4000-8000-0000000000a1";

describe("CreateAudienceRequestSchema — offerId", () => {
  it("accepts an offer id and returns it verbatim", () => {
    const parsed = CreateAudienceRequestSchema.parse({
      name: "US SaaS founders",
      brandId: BRAND,
      offerId: OFFER,
    });
    expect(parsed.offerId).toBe(OFFER);
  });

  it("is optional — a create with no offer parses, offerId undefined", () => {
    const parsed = CreateAudienceRequestSchema.parse({
      name: "US SaaS founders",
      brandId: BRAND,
    });
    expect(parsed.offerId).toBeUndefined();
  });

  it("rejects a non-uuid offer id (fail loud, never stored as junk)", () => {
    const parsed = CreateAudienceRequestSchema.safeParse({
      name: "US SaaS founders",
      brandId: BRAND,
      offerId: "offer-1",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("ListAudiencesQuerySchema — offerId", () => {
  it("accepts offerId to narrow the list to one offer", () => {
    const parsed = ListAudiencesQuerySchema.parse({ offerId: OFFER });
    expect(parsed.offerId).toBe(OFFER);
  });

  it("stays optional — no offerId means every offer, as before", () => {
    const parsed = ListAudiencesQuerySchema.parse({ brandId: BRAND });
    expect(parsed.offerId).toBeUndefined();
  });

  it("rejects a non-uuid offerId", () => {
    expect(ListAudiencesQuerySchema.safeParse({ offerId: "nope" }).success).toBe(
      false
    );
  });
});

describe("UpdateAudienceRequestSchema — offerId is immutable", () => {
  it("400s a PATCH that tries to re-scope the audience to another offer", () => {
    const parsed = UpdateAudienceRequestSchema.safeParse({ offerId: OFFER });
    expect(parsed.success).toBe(false);
  });
});

describe("AudienceSchema — offerId is always present on a read", () => {
  const base = {
    id: "00000000-0000-4000-8000-0000000000b1",
    orgId: "00000000-0000-4000-8000-000000000001",
    brandId: BRAND,
    name: "US SaaS founders",
    nlPrompt: null,
    description: null,
    provider: null,
    apolloAudienceId: null,
    crmUploadId: null,
    status: "active" as const,
    source: null,
    canonicalAudienceId: null,
    filters: null,
    avatarUrl: null,
    apolloCount: null,
    apifyCount: null,
    countedAt: null,
    createdByUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts null (an offer-less audience) and a uuid", () => {
    expect(AudienceSchema.parse({ ...base, offerId: null }).offerId).toBeNull();
    expect(AudienceSchema.parse({ ...base, offerId: OFFER }).offerId).toBe(OFFER);
  });

  it("requires the key — a serializer that forgets it fails loud", () => {
    expect(AudienceSchema.safeParse(base).success).toBe(false);
  });
});
