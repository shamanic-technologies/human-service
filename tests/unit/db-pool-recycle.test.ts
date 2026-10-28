import { describe, it, expect } from "vitest";

// BOX-LOAD-1028-PG-CONNS: a Postgres backend keeps the memory of the biggest
// query it ever ran until it exits, so the pool recycles its connections
// (5 min lifetime, 60 s idle) instead of postgres.js's 30-60 min default.
describe("db pool recycles its connections", () => {
  it("sets max_lifetime 300 s, idle_timeout 60 s, max 10", async () => {
    const { sql } = await import("../../src/db/index.js");
    expect(sql.options.max_lifetime).toBe(300);
    expect(sql.options.idle_timeout).toBe(60);
    expect(sql.options.max).toBe(10);
  });
});
