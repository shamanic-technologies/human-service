import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { isTransientConnectError } from "../../src/db/boot-migrate.js";
import { requireMigratedSchema } from "../../src/middleware/readiness.js";
import healthRoutes from "../../src/routes/health.js";
import {
  getMigrationState,
  markMigrationsFailed,
  markMigrationsPending,
  markMigrationsReady,
} from "../../src/lib/migration-state.js";

function makeApp() {
  const app = express();
  app.use(requireMigratedSchema);
  app.use(healthRoutes);
  app.get("/orgs/audiences", (_req, res) => {
    res.json({ audiences: [] });
  });
  return app;
}

afterEach(() => {
  markMigrationsReady();
});

describe("isTransientConnectError", () => {
  it("matches a bare postgres.js connect timeout", () => {
    const err = Object.assign(new Error("write CONNECT_TIMEOUT"), { code: "CONNECT_TIMEOUT" });
    expect(isTransientConnectError(err)).toBe(true);
  });

  it("matches Node happy-eyeballs AggregateError wrapping per-address ETIMEDOUTs", () => {
    // The exact shape a suspended Neon compute produces on the first connect:
    // one sub-error per candidate address, each timing out on its own budget.
    const agg = Object.assign(new AggregateError([], "") as Error & { errors: unknown[] }, {
      code: "ETIMEDOUT",
      errors: [
        Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:5432"), { code: "ETIMEDOUT" }),
        Object.assign(new Error("connect ETIMEDOUT [::1]:5432"), { code: "ETIMEDOUT" }),
      ],
    });
    expect(isTransientConnectError(agg)).toBe(true);
  });

  it("walks the cause chain", () => {
    const err = new Error("migration failed", {
      cause: Object.assign(new Error("boom"), { code: "ECONNREFUSED" }),
    });
    expect(isTransientConnectError(err)).toBe(true);
  });

  it("matches the pool-level connect message that carries no code", () => {
    // Only a message branch can catch this one — there is no `.code` on it.
    expect(isTransientConnectError(new Error("timeout exceeded when trying to connect"))).toBe(true);
  });

  it("matches a Postgres compute that is still starting up", () => {
    const err = Object.assign(new Error("the database system is starting up"), { code: "57P03" });
    expect(isTransientConnectError(err)).toBe(true);
  });

  it("does NOT match a real schema error — those must stay terminal", () => {
    const err = Object.assign(new Error('relation "audiences" does not exist'), { code: "42P01" });
    expect(isTransientConnectError(err)).toBe(false);
  });

  it("does NOT match a syntax error in a migration", () => {
    const err = Object.assign(new Error('syntax error at or near "CRATE"'), { code: "42601" });
    expect(isTransientConnectError(err)).toBe(false);
  });

  it("terminates on a self-referencing cause chain", () => {
    const err = new Error("loop") as Error & { cause?: unknown };
    err.cause = err;
    expect(isTransientConnectError(err)).toBe(false);
  });
});

describe("readiness gate", () => {
  it("defaults to ready so embedded/test use is never gated", () => {
    expect(getMigrationState()).toBe("ready");
  });

  it("serves /health 200 while migrations are still running", async () => {
    markMigrationsPending();
    const res = await request(makeApp()).get("/health");
    // This is the whole point: Railway's healthcheck passes inside its 30s
    // window even though a cold Neon compute has not finished resuming.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "human", migrations: "pending" });
  });

  it("holds DB-backed routes at 503 while migrations are still running", async () => {
    markMigrationsPending();
    const res = await request(makeApp()).get("/orgs/audiences");
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.body.error).toMatch(/migrations are still running/);
  });

  it("reports /health unhealthy when migrations failed terminally", async () => {
    markMigrationsFailed('42P01: relation "audiences" does not exist');
    const res = await request(makeApp()).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "error", service: "human", migrations: "failed" });
  });

  it("surfaces the migration failure on gated routes instead of serving them", async () => {
    markMigrationsFailed('42P01: relation "audiences" does not exist');
    const res = await request(makeApp()).get("/orgs/audiences");
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('relation "audiences" does not exist');
  });

  it("opens every route once migrations land", async () => {
    markMigrationsPending();
    markMigrationsReady();
    const res = await request(makeApp()).get("/orgs/audiences");
    expect(res.status).toBe(200);
  });
});
