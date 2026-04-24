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
