// Closed vocabularies of the audience split (src/services/audience-split.ts),
// kept dependency-free so src/schemas.ts can publish them as OpenAPI enums
// without importing the DB layer.

/** The axes a split may use — exactly the ones a people-search provider can
 * filter on. Anything else (intent, product, revenue guesses) is not findable. */
export const SPLIT_AXES = [
  "geography",
  "company_size",
  "industry",
  "seniority_role",
] as const;
export type SplitAxis = (typeof SPLIT_AXES)[number];

/**
 * The closed icon vocabulary the dashboard renders. Tokens are Phosphor icon
 * names in kebab-case (`globe-hemisphere-west` = `<GlobeHemisphereWest />` in
 * @phosphor-icons/react). The description next to each token is what the judge
 * reads to pick it. Adding a token is additive for the dashboard only if it
 * maps it; keep this list and the OpenAPI enum in lockstep (they share it).
 */
export const SPLIT_ICONS: Record<string, string> = {
  "globe-hemisphere-west": "the Americas, North or South America, the US, Canada, Latin America",
  "globe-hemisphere-east": "Europe, Africa, the Middle East, Asia, Oceania, or a whole continent in the Eastern Hemisphere",
  "map-pin": "one specific country, region, state, canton or city",
  "user": "solo founders, freelancers, one-person businesses",
  "users-three": "small teams and small companies (a handful to a few dozen people)",
  "buildings": "mid-sized companies with several departments",
  "building-office": "large enterprises and corporations",
  "crown": "top executives: CEOs, founders, owners, C-level",
  "briefcase": "managers, directors, heads of a function",
  "user-circle": "individual contributors and hands-on practitioners",
  "rocket-launch": "startups and fast-growing young companies",
  "code": "software, SaaS, developers, IT",
  "cpu": "hardware, electronics, deep tech, AI",
  "storefront": "retail shops, e-commerce, consumer brands",
  "shopping-cart": "online stores and direct-to-consumer sellers",
  "factory": "manufacturing and industrial companies",
  "stethoscope": "healthcare, clinics, doctors, medical practices",
  "first-aid-kit": "pharmacies, health products, wellness",
  "bank": "finance, banking, insurance, fintech",
  "scales": "legal services, law firms, compliance",
  "graduation-cap": "education, schools, universities, training",
  "megaphone": "marketing, advertising, PR and communication agencies",
  "handshake": "consulting, professional services, agencies serving businesses",
  "house-line": "real estate, property, construction",
  "truck": "logistics, transport, supply chain",
  "fork-knife": "restaurants, hospitality, food and beverage",
  "airplane-tilt": "travel and tourism",
  "leaf": "sustainability, agriculture, energy, cleantech",
  "paint-brush": "creative, design, media and entertainment",
  "heartbeat": "non-profits, public sector, associations",
  "target": "any other segment none of the above describes well",
};

