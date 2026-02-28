import { db } from "../db/index.js";
import { orgs, users } from "../db/schema.js";
import { and, eq } from "drizzle-orm";

export async function getOrCreateOrg(
  appId: string,
  orgId: string
): Promise<string> {
  // Try insert, ignore conflict
  await db
    .insert(orgs)
    .values({ appId, orgId })
    .onConflictDoNothing({ target: [orgs.appId, orgs.orgId] });

  // Always fetch to handle race conditions
  const [org] = await db
    .select({ id: orgs.id })
    .from(orgs)
    .where(and(eq(orgs.appId, appId), eq(orgs.orgId, orgId)))
    .limit(1);

  return org.id;
}

export async function getOrCreateUser(
  orgInternalId: string,
  userId: string
): Promise<string> {
  await db
    .insert(users)
    .values({ orgInternalId, userId })
    .onConflictDoNothing({
      target: [users.orgInternalId, users.userId],
    });

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.orgInternalId, orgInternalId),
        eq(users.userId, userId)
      )
    )
    .limit(1);

  return user.id;
}
