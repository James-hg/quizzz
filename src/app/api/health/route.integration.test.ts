import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testUrl = process.env.DATABASE_URL;
const globalForDb = globalThis as unknown as { __quizzzDb?: { client: { end(): Promise<void> } } };

async function loadRoute() {
  vi.resetModules();
  return import("./route");
}

async function resetDb() {
  await globalForDb.__quizzzDb?.client.end();
  globalForDb.__quizzzDb = undefined;
}

describe("GET /api/health", () => {
  beforeEach(resetDb);
  afterEach(async () => {
    await resetDb();
    process.env.DATABASE_URL = testUrl;
  });

  it("returns ok and db: true when the database is reachable", async () => {
    const { GET } = await loadRoute();
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true });
  });

  it("returns db: false instead of crashing when the database is unreachable", async () => {
    process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/none";
    const { GET } = await loadRoute();
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: false });
  });
});
