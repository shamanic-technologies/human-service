// OUTREACH-3WAYS-1121: who an audience is TO THE BRAND beyond "buyers of offer X".
// Dependency-free so schemas.ts publishes it as an OpenAPI enum.
//   investors      : the brand's equity investors (business angels, early-stage VCs).
//   industry_peers : founders and leaders of companies in the brand's industry,
//                    competitors included.
// No relation (NULL) = buyers of the audience's offer, every audience until now.
export const BRAND_RELATIONS = ["investors", "industry_peers"] as const;
export type BrandRelationName = (typeof BRAND_RELATIONS)[number];
