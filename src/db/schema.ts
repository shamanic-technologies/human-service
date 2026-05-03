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
