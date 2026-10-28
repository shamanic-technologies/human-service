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
// `connect_timeout: 30` is already the postgres.js default (brand-service#389),
// so it is not set here.
net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

const connectionString = process.env.HUMAN_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("HUMAN_SERVICE_DATABASE_URL is not set");
}

// Connections are RECYCLED (BOX-LOAD-1028-PG-CONNS). A Postgres backend keeps the
// memory of the biggest query it ever ran until it exits; at postgres.js's default
// lifetime (30-60 min) human_service's 10 backends held ~0.2 GB private memory on
// the shared box (2026-10-28). `max_lifetime` 5 min
// ends a connection after its current query (postgres.js never cuts a running
// query or a reserved connection); `idle_timeout` 60 s closes the ones a quiet
// stretch leaves unused. The reconnect is a local-network handshake, cheap next
// to holding that memory for an hour. `max` stays postgres.js's 10, now stated.
export const POOL_OPTIONS = { max: 10, idle_timeout: 60, max_lifetime: 300 } as const;
export const sql = postgres(connectionString, POOL_OPTIONS);
export const db = drizzle(sql, { schema });
