// The NAME of one offer, read from brand-service (the offer's owner). An offer's
// one audience (role 'target', offer-audiences.ts) is named after its offer.
// Fail loud: brand-service errors propagate; an offer the org does not hold
// under the brand is null (the caller decides: never a guessed name).
import { listBrandOffers } from "./brand-offers.js";

export async function readOfferName(orgId: string, brandId: string, offerId: string): Promise<string | null> {
  const offers = await listBrandOffers(brandId, orgId);
  const offer = offers.find((o) => o.offerId === offerId);
  return offer ? offer.name : null;
}
