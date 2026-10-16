import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTestTransaction } from "@/test/db";
import { checkDb } from "./health";

const tx = withTestTransaction();

describe("database wiring", () => {
  it("runs a query against the test database", async () => {
    const rows = await tx().execute(sql`select 1 as one`);
    expect(rows[0]?.one).toBe(1);
  });

  it("rolls back changes between tests", async () => {
    await tx().execute(sql`create temp table scratch (id int)`);
    await tx().execute(sql`insert into scratch values (1)`);
    const rows = await tx().execute(sql`select count(*)::int as n from scratch`);
    expect(rows[0]?.n).toBe(1);
  });

  it("reports the database as reachable", async () => {
    expect(await checkDb(tx())).toBe(true);
  });
});
