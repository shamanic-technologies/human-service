import { db } from "../../src/db/index.js";
import { humanProfiles } from "../../src/db/schema.js";
import { sql } from "../../src/db/index.js";

export async function cleanTestData() {
  await db.delete(humanProfiles);
}

export async function closeDb() {
  await sql.end();
}

export async function insertProfile(data: {
  appId: string;
  orgId?: string;
  userId?: string;
  name: string;
  urls: string[];
  maxPages?: number;
  cacheTtlHours?: number;
  lastScrapedAt?: Date;
  scrapedPages?: unknown[];
  writingStyle?: string;
  bio?: string;
  topics?: string[];
  tone?: string;
  vocabulary?: string;
}) {
  const [profile] = await db
    .insert(humanProfiles)
    .values({
      appId: data.appId,
      orgId: data.orgId,
      userId: data.userId,
      name: data.name,
      urls: data.urls,
      maxPages: data.maxPages ?? 3,
      cacheTtlHours: data.cacheTtlHours ?? 24,
      lastScrapedAt: data.lastScrapedAt,
      scrapedPages: data.scrapedPages as typeof humanProfiles.$inferInsert["scrapedPages"],
      writingStyle: data.writingStyle,
      bio: data.bio,
      topics: data.topics,
      tone: data.tone,
      vocabulary: data.vocabulary,
    })
    .returning();
  return profile;
}
