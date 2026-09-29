import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/brand-offers.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/brand-offers.js")>()),
  listBrandOffers: vi.fn(),
}));
vi.mock("../../src/lib/chat-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/chat-client.js")>()),
  completeJson: vi.fn(),
}));

vi.mock("../../src/services/runs.js", () => ({
  createRun: vi.fn(async () => "11111111-1111-4111-8111-111111111111"),
  completeRun: vi.fn(async () => undefined),
}));

import { completeRun, createRun } from "../../src/services/runs.js";
import { listBrandOffers } from "../../src/lib/brand-offers.js";
import { completeJson } from "../../src/lib/chat-client.js";
import {
  AudienceTargetOfferNotFoundError,
  buildTargetMessage,
  buildTargetSystemPrompt,
  draftAudienceTarget,
} from "../../src/services/audience-target.js";

const BRAND = "c4b5284d-5add-440d-917e-0c79d920a0d4";
const OFFER = "9dd56c89-a9b7-43b4-bece-16a647c24cda";
const OTHER = "7b5c063d-e33f-4440-87fb-1f1e6aa4e850";
const identity = { orgId: "308f528f-03ad-44b1-9cbc-623a6af9ba0e", userId: "u1", runId: "r1" };
const offers = [
  { offerId: OFFER, brandId: BRAND, name: "Perpetual Futures", description: "The buyer can trade perpetual futures contracts." },
  { offerId: OTHER, brandId: BRAND, name: "Liquidity Pool", description: null },
];

/** Pins the target's invariants, not its prose. */
describe("audience target prompt", () => {
  const prompt = buildTargetSystemPrompt();
  const lower = prompt.toLowerCase();

  it("names PEOPLE whose job makes them care about what is sold, not only companies", () => {
    expect(prompt).toContain("THE TARGET NAMES PEOPLE, NOT ONLY COMPANIES");
    expect(lower).toContain("everyone who works at the right");
    expect(lower).toContain("derive those roles");
    expect(lower).toContain("from what is sold");
  });

  it("keeps the people around the decision in: assistants, chiefs of staff, advisors, coaches, team managers", () => {
    for (const w of ["assistants", "chiefs of", "advisors", "coaches", "managers of the teams"]) {
      expect(lower).toContain(w);
    }
    expect(prompt).toContain("ALSO in the target");
  });

  it("names the no-stake functions as out, and seniority alone never qualifies", () => {
    expect(lower).toContain("no stake in this purchase");
    expect(prompt).toContain("OUT");
    expect(lower).toContain("seniority alone never puts someone in");
  });

  it("restates the companies, never redefines them", () => {
    expect(prompt).toContain("RESTATE, NEVER REDEFINE THE COMPANIES");
    expect(lower).toContain("add none");
    expect(lower).toContain("keep exactly those people");
  });

  it("carries no hardcoded role list per industry and no provider vocabulary", () => {
    for (const w of ["hr", "recruit", "compliance", "legal", "marketing", "ceo", "trader", "crypto"]) {
      expect(lower).not.toMatch(new RegExp(`\\b${w}`));
    }
    for (const field of ["person_titles", "person_seniorities", "q_keywords"]) {
      expect(prompt).not.toContain(field);
    }
  });

  it("gives the model what the company sells beside the customer's words", () => {
    const msg = buildTargetMessage("crypto market making firms", offers);
    expect(msg).toContain("crypto market making firms");
    expect(msg).toContain("Perpetual Futures: The buyer can trade perpetual futures contracts.");
    expect(msg).toContain("- Liquidity Pool");
  });
});

describe("draftAudienceTarget", () => {
  beforeEach(() => {
    vi.mocked(listBrandOffers).mockReset();
    vi.mocked(completeJson).mockReset();
  });

  it("reads THE offer when one is given, and returns the drafted target", async () => {
    vi.mocked(listBrandOffers).mockResolvedValue(offers);
    vi.mocked(completeJson).mockResolvedValue({ target: "  Heads of trading at crypto market makers.  " });
    const t = await draftAudienceTarget({ customerTarget: "crypto market making firms", brandId: BRAND, offerId: OFFER, identity });
    expect(t).toBe("Heads of trading at crypto market makers.");
    expect(listBrandOffers).toHaveBeenCalledWith(BRAND, identity.orgId);
    const msg = vi.mocked(completeJson).mock.calls[0][0].message;
    expect(msg).toContain("Perpetual Futures");
    expect(msg).not.toContain("Liquidity Pool");
  });

  it("reads every offer of the brand when none is given", async () => {
    vi.mocked(listBrandOffers).mockResolvedValue(offers);
    vi.mocked(completeJson).mockResolvedValue({ target: "x" });
    await draftAudienceTarget({ customerTarget: "t", brandId: BRAND, offerId: null, identity });
    const msg = vi.mocked(completeJson).mock.calls[0][0].message;
    expect(msg).toContain("Perpetual Futures");
    expect(msg).toContain("Liquidity Pool");
  });

  it("fails loud when the given offer is not the brand's", async () => {
    vi.mocked(listBrandOffers).mockResolvedValue([offers[1]]);
    await expect(
      draftAudienceTarget({ customerTarget: "t", brandId: BRAND, offerId: OFFER, identity })
    ).rejects.toBeInstanceOf(AudienceTargetOfferNotFoundError);
    expect(completeJson).not.toHaveBeenCalled();
  });

  it("returns null (no LLM call) when the brand holds no offer at all", async () => {
    vi.mocked(listBrandOffers).mockResolvedValue([]);
    const t = await draftAudienceTarget({ customerTarget: "t", brandId: BRAND, offerId: null, identity });
    expect(t).toBeNull();
    expect(completeJson).not.toHaveBeenCalled();
  });

  it("opens its OWN run when the request carries none (chat-service requires x-run-id)", async () => {
    vi.mocked(listBrandOffers).mockResolvedValue(offers);
    vi.mocked(completeJson).mockResolvedValue({ target: "x" });
    vi.mocked(createRun).mockClear();
    vi.mocked(completeRun).mockClear();
    await draftAudienceTarget({
      customerTarget: "t",
      brandId: BRAND,
      offerId: OFFER,
      identity: { orgId: identity.orgId, userId: "u1" },
    });
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: identity.orgId, userId: "u1", taskName: "audience-target-draft" })
    );
    expect(vi.mocked(completeJson).mock.calls[0][0].identity.runId).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
    expect(completeRun).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "completed",
      expect.anything()
    );
  });

  it("uses the inbound run when there is one", async () => {
    vi.mocked(listBrandOffers).mockResolvedValue(offers);
    vi.mocked(completeJson).mockResolvedValue({ target: "x" });
    vi.mocked(createRun).mockClear();
    await draftAudienceTarget({ customerTarget: "t", brandId: BRAND, offerId: OFFER, identity });
    expect(createRun).not.toHaveBeenCalled();
    expect(vi.mocked(completeJson).mock.calls[0][0].identity.runId).toBe("r1");
  });

  it("fails loud on an empty answer", async () => {
    vi.mocked(listBrandOffers).mockResolvedValue(offers);
    vi.mocked(completeJson).mockResolvedValue({ target: "  " });
    await expect(
      draftAudienceTarget({ customerTarget: "t", brandId: BRAND, offerId: OFFER, identity })
    ).rejects.toThrow("no audience target");
  });
});
