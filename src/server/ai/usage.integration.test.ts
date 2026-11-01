import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { aiProviderState, aiRateWindows, aiUsage } from "@/server/db/schema";
import { resetAiState } from "@/test/ai-state";
import { deleteUsers, signUpUser, type TestUser } from "@/test/users";
import { AiBusy, AiPaused, AiRateLimited } from "./errors";
import {
  admitAiOperation,
  LEASE_TTL_MS,
  PAUSE_MS,
  QUOTA_STREAK_WINDOW_MS,
  readPausedUntil,
  recordProviderSuccess,
  recordQuotaError,
  releaseAiOperation,
  type AiLimits,
} from "./usage";

process.env.AUTH_RATE_LIMIT_MAX = "1000";
const db = getDb();
let alice: TestUser;
let bob: TestUser;

const roomy: AiLimits = {
  perMinute: 100,
  perHour: 100,
  perDay: 100,
  globalPerDay: 100,
  maxConcurrent: 100,
};
const admit = (user: TestUser, limits: Partial<AiLimits>, now: Date) =>
  admitAiOperation(db, { userId: user.id, route: "chat", limits: { ...roomy, ...limits }, now });
const free = async (user: TestUser, limits: Partial<AiLimits>, now: Date) =>
  releaseAiOperation(db, await admit(user, limits, now));

beforeAll(async () => {
  alice = await signUpUser(db);
  bob = await signUpUser(db);
});
beforeEach(async () => {
  await resetAiState(db);
  await db.delete(aiUsage).where(eq(aiUsage.userId, alice.id));
  await db.delete(aiUsage).where(eq(aiUsage.userId, bob.id));
});
afterAll(async () => {
  await resetAiState(db);
  await deleteUsers(db, [alice.id, bob.id]);
});

describe("caps", () => {
  it("allows the per-minute limit, refuses the next, and starts fresh the next minute", async () => {
    const now = new Date("2026-03-01T10:15:10Z");
    await free(alice, { perMinute: 2 }, now);
    await free(alice, { perMinute: 2 }, now);
    const refused = await admit(alice, { perMinute: 2 }, now).catch((e) => e);
    expect(refused).toBeInstanceOf(AiRateLimited);
    expect(refused.details.retryAt).toBe("2026-03-01T10:16:00.000Z");
    await expect(
      free(alice, { perMinute: 2 }, new Date("2026-03-01T10:16:00Z")),
    ).resolves.toBeUndefined();
  });

  it("enforces the hourly cap and resets in the next UTC hour", async () => {
    const now = new Date("2026-03-01T10:15:00Z");
    await free(alice, { perHour: 1 }, now);
    await expect(admit(alice, { perHour: 1 }, now)).rejects.toThrow(/hourly/);
    await expect(free(alice, { perHour: 1 }, new Date("2026-03-01T11:00:00Z"))).resolves.toBe(
      undefined,
    );
  });

  it("enforces the per-user day cap on UTC days", async () => {
    await free(alice, { perDay: 2 }, new Date("2026-03-01T01:00:00Z"));
    await free(alice, { perDay: 2 }, new Date("2026-03-01T23:00:00Z"));
    await expect(admit(alice, { perDay: 2 }, new Date("2026-03-01T23:59:00Z"))).rejects.toThrow(
      /today/,
    );
    // Another user is not affected, and midnight UTC starts a new day.
    await free(bob, { perDay: 2 }, new Date("2026-03-01T23:59:00Z"));
    await free(alice, { perDay: 2 }, new Date("2026-03-02T00:00:00Z"));
  });

  it("shares the global day cap between users", async () => {
    const now = new Date("2026-03-01T10:00:00Z");
    await free(alice, { globalPerDay: 2 }, now);
    await free(bob, { globalPerDay: 2 }, now);
    const refused = await admit(alice, { globalPerDay: 2 }, now).catch((e) => e);
    expect(refused).toBeInstanceOf(AiRateLimited);
    expect(refused.message).toMatch(/for everyone/);
  });

  it("counts nothing for a refused operation", async () => {
    const now = new Date("2026-03-01T10:00:00Z");
    await free(alice, { perHour: 1 }, now);
    await admit(alice, { perHour: 1 }, now).catch(() => {});
    await admit(bob, { globalPerDay: 1 }, now).catch(() => {});
    const rows = await db.select().from(aiRateWindows);
    const counts = Object.fromEntries(rows.map((r) => [`${r.subject}:${r.period}`, r.count]));
    expect(counts[`${alice.id}:minute`]).toBe(1);
    expect(counts["global:day"]).toBe(1);
    expect(counts[`${bob.id}:minute`]).toBeUndefined();
    const [hour] = await db.select().from(aiUsage).where(eq(aiUsage.userId, alice.id));
    expect(hour?.count).toBe(1);
  });
});

describe("concurrency", () => {
  it("never admits more than the limit at once, even from separate connections", async () => {
    const now = new Date("2026-03-01T10:00:00Z");
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => admit(i % 2 ? alice : bob, { maxConcurrent: 3 }, now)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed.every((r) => r.reason instanceof AiBusy)).toBe(true);
  });

  it("frees a slot on release, and releasing twice is harmless", async () => {
    const now = new Date("2026-03-01T10:00:00Z");
    const first = await admit(alice, { maxConcurrent: 1 }, now);
    await expect(admit(bob, { maxConcurrent: 1 }, now)).rejects.toBeInstanceOf(AiBusy);
    await releaseAiOperation(db, first);
    await releaseAiOperation(db, first);
    await admit(bob, { maxConcurrent: 1 }, now);
  });

  it("ignores a lease that was never released once it has expired", async () => {
    const now = new Date("2026-03-01T10:00:00Z");
    await admit(alice, { maxConcurrent: 1 }, now);
    const later = new Date(now.getTime() + LEASE_TTL_MS - 1000);
    await expect(admit(bob, { maxConcurrent: 1 }, later)).rejects.toBeInstanceOf(AiBusy);
    await admit(bob, { maxConcurrent: 1 }, new Date(now.getTime() + LEASE_TTL_MS + 1));
  });
});

describe("provider quota pause", () => {
  const t0 = new Date("2026-03-01T10:00:00Z");
  const after = (ms: number) => new Date(t0.getTime() + ms);

  it("pauses after two quota errors in a short time, not after one", async () => {
    const a = await admit(alice, {}, t0);
    await recordQuotaError(db, a, t0);
    await releaseAiOperation(db, a);
    await free(alice, {}, after(1000));
    const b = await admit(alice, {}, after(2000));
    await recordQuotaError(db, b, after(2000));
    await releaseAiOperation(db, b);
    const paused = await admit(alice, {}, after(3000)).catch((e) => e);
    expect(paused).toBeInstanceOf(AiPaused);
    expect(paused.status).toBe(503);
    expect(paused.details.retryAt).toBe(after(2000 + PAUSE_MS).toISOString());
  });

  it("does not pause when the errors are far apart", async () => {
    const a = await admit(alice, {}, t0);
    await recordQuotaError(db, a, t0);
    const b = await admit(alice, {}, after(QUOTA_STREAK_WINDOW_MS + 1000));
    await recordQuotaError(db, b, after(QUOTA_STREAK_WINDOW_MS + 1000));
    await admit(alice, {}, after(QUOTA_STREAK_WINDOW_MS + 2000));
  });

  async function pause() {
    const a = await admit(alice, {}, t0);
    await recordQuotaError(db, a, t0);
    await recordQuotaError(db, a, after(1));
    await releaseAiOperation(db, a);
  }

  it("lets exactly one trial through after the cooldown", async () => {
    await pause();
    const cooled = after(PAUSE_MS + 1000);
    const trial = await admit(alice, {}, cooled);
    expect(trial.isProbe).toBe(true);
    await expect(admit(bob, {}, cooled)).rejects.toBeInstanceOf(AiPaused);
    // If the trial ends without an answer, the next request may try.
    await releaseAiOperation(db, trial);
    expect((await admit(bob, {}, cooled)).isProbe).toBe(true);
  });

  it("recovers when the trial succeeds", async () => {
    await pause();
    const cooled = after(PAUSE_MS + 1000);
    const trial = await admit(alice, {}, cooled);
    await recordProviderSuccess(db);
    await releaseAiOperation(db, trial);
    expect(await readPausedUntil(db)).toBeNull();
    expect((await admit(bob, {}, cooled)).isProbe).toBe(false);
  });

  it("pauses again straight away when the trial hits quota", async () => {
    await pause();
    const cooled = after(PAUSE_MS + 1000);
    const trial = await admit(alice, {}, cooled);
    await recordQuotaError(db, trial, cooled);
    await releaseAiOperation(db, trial);
    await expect(admit(bob, {}, after(PAUSE_MS + 2000))).rejects.toBeInstanceOf(AiPaused);
    const [state] = await db.select().from(aiProviderState);
    expect(state?.pausedUntil?.toISOString()).toBe(
      new Date(cooled.getTime() + PAUSE_MS).toISOString(),
    );
  });
});
