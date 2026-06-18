import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// --- Primary entity ---

export const humans = pgTable(
  "humans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),

    // Identity
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    bio: text("bio"),
    expertise: text("expertise").array(),
    knownFor: text("known_for"),
    imageUrl: text("image_url"),

    // Scraping input
    urls: text("urls").array().notNull(),
    maxPages: integer("max_pages").notNull().default(10),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_humans_org_slug").on(table.orgId, table.slug),
    index("idx_humans_org").on(table.orgId),
  ]
);

// --- Rich AI-extracted methodology (1:1 with humans, cached with TTL) ---

export interface Framework {
  name: string;
  description: string;
  applicationContext: string;
}

export interface ToneProfile {
  register: string;
  pace: string;
  vocabulary: string;
  perspective: string;
  examples: string[];
}

export interface PersuasionStyle {
  primary: string;
  techniques: string[];
  callToAction: string;
}

export const humanMethodologies = pgTable(
  "human_methodologies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    humanId: uuid("human_id")
      .references(() => humans.id, { onDelete: "cascade" })
      .notNull()
      .unique(),
    orgId: text("org_id"),

    frameworks: jsonb("frameworks").$type<Framework[]>(),
    strategicPatterns: text("strategic_patterns").array(),
    toneOfVoice: jsonb("tone_of_voice").$type<ToneProfile>(),
    persuasionStyle: jsonb("persuasion_style").$type<PersuasionStyle>(),
    contentSignatures: text("content_signatures").array(),
    avoids: text("avoids").array(),

    extractionModel: text("extraction_model"),
    sourceUrls: text("source_urls").array(),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    // Workflow tracking — populated when extraction is triggered from a workflow
    campaignId: text("campaign_id"),
    brandIds: text("brand_ids").array(),
    workflowSlug: text("workflow_slug"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_methodologies_human").on(table.humanId),
    index("idx_methodologies_org_brand").on(table.orgId),
  ]
);

// --- CRM v1: lists + list_members ---
//
// Org-scoped curated lists of contacts. v1 references contacts via
// (source_service, source_resource_id) string pointer because silver `humans`
// table doesn't exist yet — lists are CRM-glue, not ingested data.
//
// v2 will add silver `humans` and populate list_members.human_id via batch
// dedup of bronze google_contacts (and future LinkedIn/Apollo) on
// lower(primary_email) per org.
//
// Note: org_id here is uuid (per platform convention for new tables).
// Existing humans/human_methodologies tables use text org_id (legacy).

export const lists = pgTable(
  "lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id"),
    name: text("name").notNull(),
    description: text("description"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_lists_org").on(table.orgId),
    index("idx_lists_brand")
      .on(table.brandId)
      .where(sql`${table.brandId} IS NOT NULL`),
  ]
);

export type List = typeof lists.$inferSelect;
export type NewList = typeof lists.$inferInsert;

export const listMembers = pgTable(
  "list_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    sourceService: text("source_service").notNull().default("google-service"),
    sourceResourceId: text("source_resource_id").notNull(),
    sourceAccountId: uuid("source_account_id"),
    humanId: uuid("human_id"),
    addedByUserId: uuid("added_by_user_id"),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_list_members_unique").on(
      table.listId,
      table.sourceService,
      table.sourceResourceId
    ),
    index("idx_list_members_org").on(table.orgId),
    index("idx_list_members_list").on(table.listId),
  ]
);

export type ListMember = typeof listMembers.$inferSelect;
export type NewListMember = typeof listMembers.$inferInsert;

// --- People gateway v1: per-brand cross-provider suppression (B/S/G) ---
//
// The people gateway serves leads for a brand via apollo OR apify. Only the
// gateway sees BOTH providers' emissions for a brand, so the cross-provider
// "already served for this brand" truth lives here (not in any single
// provider). Two layers:
//
//   🥉 bronze `lead_serves`        — append-only, immutable, source-faithful
//                                    event log. Full audit. Silver rebuildable
//                                    from it when identity-resolution evolves.
//   🥈 silver `brand_suppressions` — canonical, deduped per (org, brand,
//                                    person). The ONLY table the read paths
//                                    (apollo teaser filter, apify exclude-set,
//                                    resolve-email block) query.
//
// Window (3 months) is enforced ON READ via `last_served_at`. No cron/cleanup
// (gold is a view if/when a consumer needs counts). org_id / brand_id are uuid
// per the new-table convention; campaign_id / run_id are text (audit-only
// forwarded headers, may not be uuid).

// 🥉 Bronze — one row per (serve, atomic brand). Never updated.
export const leadServes = pgTable(
  "lead_serves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    provider: text("provider").notNull(), // "apollo" | "apify"
    providerPersonId: text("provider_person_id"),
    // Raw identity as-received from the provider (source-faithful).
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    linkedinUrl: text("linkedin_url"),
    companyDomain: text("company_domain"),
    // Provenance.
    campaignId: text("campaign_id"),
    runId: text("run_id"),
    // The audience this serve was made under (audit-only link to `audiences`).
    audienceId: uuid("audience_id"),
    servedAt: timestamp("served_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_lead_serves_org_brand").on(table.orgId, table.brandId),
    index("idx_lead_serves_served_at").on(table.servedAt),
  ]
);

export type LeadServe = typeof leadServes.$inferSelect;
export type NewLeadServe = typeof leadServes.$inferInsert;

// 🥈 Silver — canonical per (org, brand, person). Promoted inline at serve time.
// Keyed on email_norm (always present when a verified email is served);
// linkedin_url_norm + provider_person_id are additional indexed match columns
// for the apollo free-teaser pre-pay lookup. Non-partial unique index on
// (org_id, brand_id, email_norm) — all NOT NULL, so ON CONFLICT infers it
// cleanly (no 42P10 partial-index trap).
export const brandSuppressions = pgTable(
  "brand_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    emailNorm: text("email_norm").notNull(),
    linkedinUrlNorm: text("linkedin_url_norm"),
    providerPersonId: text("provider_person_id"),
    lastProvider: text("last_provider"),
    firstServedAt: timestamp("first_served_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastServedAt: timestamp("last_served_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_brand_suppressions_unique").on(
      table.orgId,
      table.brandId,
      table.emailNorm
    ),
    index("idx_brand_suppressions_linkedin").on(
      table.orgId,
      table.brandId,
      table.linkedinUrlNorm
    ),
    index("idx_brand_suppressions_person").on(
      table.orgId,
      table.brandId,
      table.providerPersonId
    ),
    index("idx_brand_suppressions_window").on(
      table.orgId,
      table.brandId,
      table.lastServedAt
    ),
  ]
);

export type BrandSuppression = typeof brandSuppressions.$inferSelect;
export type NewBrandSuppression = typeof brandSuppressions.$inferInsert;

// --- People gateway v1: audiences + canonical people + membership bridge ---
//
// Naming follows CDP/CRM canon (Segment / Salesforce CDP / Adobe AEP / HubSpot):
//   - `audiences`        — a saved neutral filter-set whose membership is
//                          computed dynamically. (CDP "dynamic audience". NOT
//                          "persona" = the trait layer above; NOT
//                          "database_search" = the mechanism.)
//   - `people`           — canonical, deduped person dimension (🥈 silver). The
//                          legacy `humans` table is expert-profiles, so the
//                          canonical person entity is `people`.
//   - `audienceMembers`  — Kimball BRIDGE for the many-to-many person<->audience
//                          relation, with effective dates for point-in-time.
//
// Membership is PROVENANCE-based: a person joins an audience iff a serve made
// under that audience returned them. No local re-implementation of provider
// matching. One person accrues many audiences over time.

// 🥈 Silver — canonical deduped person. Dedup keys: email_norm (canonical) then
// linkedin_url_norm then provider person ids. Non-partial unique on
// (org_id, email_norm) — email_norm nullable, NULLs distinct, ON CONFLICT-safe.
export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    emailNorm: text("email_norm"),
    linkedinUrlNorm: text("linkedin_url_norm"),
    apolloPersonId: text("apollo_person_id"),
    apifyPersonId: text("apify_person_id"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    fullName: text("full_name"),
    companyDomain: text("company_domain"),
    companyName: text("company_name"),
    title: text("title"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_people_org_email").on(table.orgId, table.emailNorm),
    index("idx_people_org_linkedin").on(table.orgId, table.linkedinUrlNorm),
    index("idx_people_org_apollo").on(table.orgId, table.apolloPersonId),
    index("idx_people_org_apify").on(table.orgId, table.apifyPersonId),
  ]
);

export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;

// 🥈 Silver — saved audience (neutral filter-set + per-provider count snapshot).
export const audiences = pgTable(
  "audiences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    name: text("name").notNull(),
    nlPrompt: text("nl_prompt"),
    // The provider this audience commits to ("apollo" | "apify"); null = neutral.
    // Set when a provider-specific candidate from /suggest is selected.
    provider: text("provider"),
    // Neutral PeopleSearchFilters shape (maps to both providers).
    filters: jsonb("filters").$type<Record<string, unknown>>(),
    apolloCount: integer("apollo_count"),
    apifyCount: integer("apify_count"),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_audiences_org_brand").on(table.orgId, table.brandId)]
);

export type Audience = typeof audiences.$inferSelect;
export type NewAudience = typeof audiences.$inferInsert;

// 🥈 Silver — Kimball bridge: person <-> audience (many-to-many).
export const audienceMembers = pgTable(
  "audience_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    audienceId: uuid("audience_id")
      .notNull()
      .references(() => audiences.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    source: text("source"), // provider that surfaced it: "apollo" | "apify"
    confidence: text("confidence").notNull().default("provider_confirmed"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastServedAt: timestamp("last_served_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_audience_members_unique").on(
      table.audienceId,
      table.personId
    ),
    index("idx_audience_members_org").on(table.orgId),
    index("idx_audience_members_person").on(table.personId),
  ]
);

export type AudienceMember = typeof audienceMembers.$inferSelect;
export type NewAudienceMember = typeof audienceMembers.$inferInsert;
