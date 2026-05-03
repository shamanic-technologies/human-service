import { db } from "../../src/db/index.js";
import {
  humans,
  humanMethodologies,
  lists,
  listMembers,
} from "../../src/db/schema.js";
import { sql } from "../../src/db/index.js";

export async function cleanTestData() {
  await db.delete(humanMethodologies);
  await db.delete(humans);
  await db.delete(listMembers);
  await db.delete(lists);
}

export async function closeDb() {
  await sql.end();
}

export async function insertHuman(data: {
  orgId: string;
  name: string;
  slug: string;
  urls: string[];
  bio?: string;
  expertise?: string[];
  knownFor?: string;
  imageUrl?: string;
  maxPages?: number;
}) {
  const [human] = await db
    .insert(humans)
    .values({
      orgId: data.orgId,
      name: data.name,
      slug: data.slug,
      urls: data.urls,
      bio: data.bio ?? null,
      expertise: data.expertise ?? null,
      knownFor: data.knownFor ?? null,
      imageUrl: data.imageUrl ?? null,
      maxPages: data.maxPages ?? 10,
    })
    .returning();
  return human;
}

export async function insertMethodology(data: {
  humanId: string;
  frameworks?: unknown[];
  strategicPatterns?: string[];
  toneOfVoice?: unknown;
  persuasionStyle?: unknown;
  contentSignatures?: string[];
  avoids?: string[];
  extractionModel?: string;
  sourceUrls?: string[];
  expiresAt?: Date;
}) {
  const [methodology] = await db
    .insert(humanMethodologies)
    .values({
      humanId: data.humanId,
      frameworks: (data.frameworks as typeof humanMethodologies.$inferInsert["frameworks"]) ?? null,
      strategicPatterns: data.strategicPatterns ?? null,
      toneOfVoice: (data.toneOfVoice as typeof humanMethodologies.$inferInsert["toneOfVoice"]) ?? null,
      persuasionStyle: (data.persuasionStyle as typeof humanMethodologies.$inferInsert["persuasionStyle"]) ?? null,
      contentSignatures: data.contentSignatures ?? null,
      avoids: data.avoids ?? null,
      extractionModel: data.extractionModel ?? null,
      sourceUrls: data.sourceUrls ?? null,
      expiresAt: data.expiresAt ?? null,
    })
    .returning();
  return methodology;
}
