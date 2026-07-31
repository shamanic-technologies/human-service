import net from "node:net";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

// Node 20's happy-eyeballs gives each candidate address only 250ms
// (`autoSelectFamilyAttemptTimeout`). A Neon compute resuming from scale-to-zero
// takes seconds, so the first connection after an idle period fails with
// `AggregateError [ETIMEDOUT]` before the wake completes. 5s per candidate is
// long enough to ride out a resume and short enough to still fail over between
// address families.
//
// Deliberately NOT set here (both disproved on brand-service#389 by reading
// postgres.js source): `connect_timeout: 30` is already the postgres.js default,
// and `idle_timeout` points the wrong way — postgres.js never closes idle
// connections by default, so setting it makes the next request pay a fresh
// TCP+TLS handshake for nothing. That advice is node-postgres's, not this
// driver's.
net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

const connectionString = process.env.HUMAN_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("HUMAN_SERVICE_DATABASE_URL is not set");
}

export const sql = postgres(connectionString);
export const db = drizzle(sql, { schema });
