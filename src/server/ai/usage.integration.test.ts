import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { aiUsage } from "@/server/db/schema";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { AiRateLimited } from "./errors";
import { consumeAiQuota } from "./usage";

process.env.AUTH_RATE_LIMIT_MAX = "1000";
const db = getDb();
let user: TestUser;

beforeAll(async () => {
  user = await signUpUser(db);
});
afterAll(async () => {
  await deleteUsers(db, [user.id]);
});

describe("consumeAiQuota", () => {
  it("allows up to the limit then refuses, per hour window", async () => {
    const now = new Date("2026-03-01T10:15:00Z");
    await consumeAiQuota(db, user.id, 2, now);
    await consumeAiQuota(db, user.id, 2, now);
    await expect(consumeAiQuota(db, user.id, 2, now)).rejects.toBeInstanceOf(AiRateLimited);
    // The next hour starts fresh.
    await expect(
      consumeAiQuota(db, user.id, 2, new Date("2026-03-01T11:00:00Z")),
    ).resolves.toBeUndefined();
  });

  it("does not let concurrent calls exceed the limit", async () => {
    const now = new Date("2026-03-02T10:00:00Z");
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => consumeAiQuota(db, user.id, 3, now)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  });

  it("prunes windows older than two days", async () => {
    await consumeAiQuota(db, user.id, 5, new Date("2026-01-01T00:00:00Z"));
    await consumeAiQuota(db, user.id, 5, new Date("2026-01-05T00:00:00Z"));
    const rows = await db.select().from(aiUsage).where(eq(aiUsage.userId, user.id));
    expect(rows.some((r) => r.windowStart.toISOString().startsWith("2026-01-01"))).toBe(false);
  });
});
