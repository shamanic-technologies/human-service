import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const humanProfiles = pgTable(
  "human_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Ownership
    appId: text("app_id").notNull(),
    orgId: text("org_id"),
    userId: text("user_id"),

    // Identity
    name: text("name").notNull(),
    urls: text("urls").array().notNull(),

    // Scraped data (cached)
    scrapedPages: jsonb("scraped_pages").$type<ScrapedPage[]>(),
    maxPages: integer("max_pages").notNull().default(3),

    // AI-extracted profile
    writingStyle: text("writing_style"),
    bio: text("bio"),
    topics: text("topics").array(),
    tone: text("tone"),
    vocabulary: text("vocabulary"),

    lastScrapedAt: timestamp("last_scraped_at", { withTimezone: true }),
    cacheTtlHours: integer("cache_ttl_hours").notNull().default(24),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_profiles_app_org").on(table.appId, table.orgId)]
);

export interface ScrapedPage {
  url: string;
  title: string;
  content: string;
  scrapedAt: string;
}

export type HumanProfile = typeof humanProfiles.$inferSelect;
export type NewHumanProfile = typeof humanProfiles.$inferInsert;
