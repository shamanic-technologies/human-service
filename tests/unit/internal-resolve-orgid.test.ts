import { describe, it, expect } from "vitest";
import { ResolveAudiencesRequestSchema } from "../../src/schemas.js";
import { isValidUuid, LAX_UUID_REGEX } from "../../src/lib/uuid.js";

// The header path (requireIdentity / requireOrgIdOnly / requireOrgAndUser) is
// UUID-validated in middleware/auth.ts. This covers the OTHER crash surface: the
// internal `POST /internal/audiences/resolve` resolver, whose body `orgId` used
// to be `z.string().min(1)` — so a doubled / comma-joined orgId passed Zod and
// reached a uuid-typed query (Postgres 22P02). It's now a lax-UUID-shape check.
const VALID_ORG = "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const VALID_BRAND = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("isValidUuid / LAX_UUID_REGEX", () => {
  it("accepts a well-formed UUID and a non-v4 (lax) shape", () => {
    expect(isValidUuid(VALID_ORG)).toBe(true);
    expect(isValidUuid("00000000-0000-1000-8000-000000000000")).toBe(true);
  });

  it("rejects doubled / comma-joined values and other malformed input", () => {
    expect(isValidUuid(`${VALID_ORG},${VALID_ORG}`)).toBe(false);
    expect(isValidUuid(`${VALID_ORG},`)).toBe(false);
    expect(isValidUuid("")).toBe(false);
    expect(isValidUuid("not-a-uuid")).toBe(false);
    expect(isValidUuid(undefined)).toBe(false);
    expect(isValidUuid(null)).toBe(false);
    expect(isValidUuid(123)).toBe(false);
  });

  it("is anchored (no partial match inside a longer string)", () => {
    expect(LAX_UUID_REGEX.test(`prefix ${VALID_ORG}`)).toBe(false);
  });
});

describe("ResolveAudiencesRequestSchema.orgId (internal resolver body)", () => {
  it("accepts a well-formed orgId", () => {
    const parsed = ResolveAudiencesRequestSchema.safeParse({
      orgId: VALID_ORG,
      brandId: VALID_BRAND,
      emails: ["a@b.com"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a doubled / comma-joined orgId (the crash trigger) with a clear error", () => {
    const parsed = ResolveAudiencesRequestSchema.safeParse({
      orgId: `${VALID_ORG}, ${VALID_ORG}`,
      brandId: VALID_BRAND,
      emails: ["a@b.com"],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/valid UUID/i);
    }
  });

  it("rejects a single-value doubled-header artifact (trailing comma)", () => {
    const parsed = ResolveAudiencesRequestSchema.safeParse({
      orgId: `${VALID_ORG},`,
      brandId: VALID_BRAND,
      emails: ["a@b.com"],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-UUID orgId that previously passed min(1)", () => {
    const parsed = ResolveAudiencesRequestSchema.safeParse({
      orgId: "org_not_a_uuid",
      brandId: VALID_BRAND,
      audienceIds: [VALID_BRAND],
    });
    expect(parsed.success).toBe(false);
  });
});
