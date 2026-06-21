import { describe, it, expect } from "vitest";
import { buildAvatarPrompt, pickAvatarPalette } from "../../src/services/audiences.js";
import { audiences } from "../../src/db/schema.js";

// Minimal audience row builder — buildAvatarPrompt only reads
// id / name / description / nlPrompt / filters.
function audience(
  over: Partial<typeof audiences.$inferSelect> = {}
): typeof audiences.$inferSelect {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "00000000-0000-4000-8000-0000000000a1",
    brandId: "00000000-0000-4000-8000-0000000000c1",
    name: "Fintech CMOs",
    nlPrompt: "fintech CMOs",
    description: null,
    provider: "apollo",
    status: "active",
    source: null,
    filters: {},
    apolloCount: null,
    apifyCount: null,
    avatarUrl: null,
    countsUpdatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as unknown as typeof audiences.$inferSelect;
}

describe("pickAvatarPalette", () => {
  it("is deterministic for a given id", () => {
    const id = "abc12345-1111-4111-8111-111111111111";
    expect(pickAvatarPalette(id)).toBe(pickAvatarPalette(id));
  });

  it("spreads colours across different ids (separability lever)", () => {
    const colours = new Set(
      Array.from({ length: 20 }, (_, i) =>
        pickAvatarPalette(`${i}0000000-0000-4000-8000-00000000000${i % 10}`)
      )
    );
    expect(colours.size).toBeGreaterThan(1);
  });
});

describe("buildAvatarPrompt", () => {
  it("drops the photorealistic-headshot wording that caused man-in-a-suit", () => {
    const p = buildAvatarPrompt(audience());
    expect(p.toLowerCase()).not.toContain("photorealistic");
    expect(p.toLowerCase()).not.toContain("headshot");
  });

  it("is a flat-vector, square, text-free emblem", () => {
    const p = buildAvatarPrompt(audience());
    expect(p).toContain("Flat vector");
    expect(p).toContain("Square 1:1");
    expect(p.toLowerCase()).toContain("no text");
  });

  it("includes role-symbolising props and a deterministic appearance", () => {
    const p = buildAvatarPrompt(audience({ filters: { titles: ["CMO"] } }));
    expect(p).toContain("symbolise their role");
    expect(/Depict (a woman|a man|a non-binary person)/.test(p)).toBe(true);
  });

  it("embeds the picked background colour", () => {
    const a = audience();
    expect(buildAvatarPrompt(a)).toContain(pickAvatarPalette(a.id));
  });

  it("prefers the per-audience description over nlPrompt", () => {
    const p = buildAvatarPrompt(
      audience({ description: "heads of growth at Series-B fintechs", nlPrompt: "fintech CMOs" })
    );
    expect(p).toContain("heads of growth at Series-B fintechs");
  });

  it("is deterministic for the same audience", () => {
    const a = audience({ id: "deadbeef-1111-4111-8111-111111111111" });
    expect(buildAvatarPrompt(a)).toBe(buildAvatarPrompt(a));
  });

  it("gives two different audiences visibly different colours", () => {
    const colours = new Set(
      Array.from({ length: 12 }, (_, i) =>
        pickAvatarPalette(`a${i}aaaaaa-1111-4111-8111-1111111111${(10 + i).toString()}`)
      )
    );
    expect(colours.size).toBeGreaterThan(1);
  });
});
