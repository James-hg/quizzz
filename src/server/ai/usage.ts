import "server-only";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Database } from "@/server/db";
import { aiCallLeases, aiProviderState, aiRateWindows, aiUsage } from "@/server/db/schema";
import { AiBusy, AiPaused, AiRateLimited } from "./errors";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A whole operation (including a second try) must finish before its lease expires. */
export const OPERATION_DEADLINE_MS = 75_000;
export const LEASE_TTL_MS = 90_000;

/** Two provider quota errors within this window pause AI... */
export const QUOTA_STREAK_WINDOW_MS = 5 * MINUTE_MS;
export const QUOTA_STREAK_TO_PAUSE = 2;
/** ...for this long, after which one trial operation is allowed. */
export const PAUSE_MS = 10 * MINUTE_MS;

export type AiLimits = {
  perMinute: number;
  perHour: number;
  perDay: number;
  globalPerDay: number;
  maxConcurrent: number;
};

export type Admission = { leaseId: string; isProbe: boolean };

const floorTo = (now: Date, ms: number) => new Date(Math.floor(now.getTime() / ms) * ms);

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Makes sure the single state row exists, then locks it so admissions run one at a time. */
async function lockState(tx: Tx) {
  await tx.insert(aiProviderState).values({ id: 1 }).onConflictDoNothing();
  const [state] = await tx
    .select()
    .from(aiProviderState)
    .where(eq(aiProviderState.id, 1))
    .for("update");
  return state!;
}

async function countOf(tx: Tx, subject: string, period: "minute" | "day", windowStart: Date) {
  const [row] = await tx
    .select({ count: aiRateWindows.count })
    .from(aiRateWindows)
    .where(
      and(
        eq(aiRateWindows.subject, subject),
        eq(aiRateWindows.period, period),
        eq(aiRateWindows.windowStart, windowStart),
      ),
    );
  return row?.count ?? 0;
}

function bump(tx: Tx, subject: string, period: "minute" | "day", windowStart: Date) {
  return tx
    .insert(aiRateWindows)
    .values({ subject, period, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [aiRateWindows.subject, aiRateWindows.period, aiRateWindows.windowStart],
      set: { count: sql`${aiRateWindows.count} + 1` },
    });
}

/**
 * Decides, in one transaction, whether one AI operation may start, and if so counts it against
 * every cap and takes a lease. Refusals change nothing. The provider state row is locked for the
 * transaction, so concurrent admissions (even from other app instances) see each other.
 */
export async function admitAiOperation(
  db: Database,
  input: { userId: string; route: string; limits: AiLimits; now?: Date },
): Promise<Admission> {
  const now = input.now ?? new Date();
  const { userId, limits } = input;

  return db.transaction(async (tx) => {
    const state = await lockState(tx);

    // Leases of crashed workers expire on their own; sweep them so they stop counting.
    await tx.delete(aiCallLeases).where(lt(aiCallLeases.expiresAt, now));
    const active = await tx
      .select({ id: aiCallLeases.id })
      .from(aiCallLeases)
      .where(gt(aiCallLeases.expiresAt, now));

    let isProbe = false;
    if (state.pausedUntil) {
      if (state.pausedUntil > now) throw new AiPaused(state.pausedUntil);
      // Cooldown is over: one trial at a time until it reports back.
      if (state.probeLeaseId && active.some((l) => l.id === state.probeLeaseId)) {
        throw new AiPaused(new Date(now.getTime() + LEASE_TTL_MS));
      }
      isProbe = true;
    }

    if (active.length >= limits.maxConcurrent) throw new AiBusy();

    const minuteStart = floorTo(now, MINUTE_MS);
    const hourStart = floorTo(now, HOUR_MS);
    const dayStart = floorTo(now, DAY_MS);

    const [hourRow] = await tx
      .select({ count: aiUsage.count })
      .from(aiUsage)
      .where(and(eq(aiUsage.userId, userId), eq(aiUsage.windowStart, hourStart)));

    if ((await countOf(tx, userId, "minute", minuteStart)) >= limits.perMinute) {
      throw new AiRateLimited(
        "You are asking for AI help too quickly. Wait a minute and try again.",
        new Date(minuteStart.getTime() + MINUTE_MS),
      );
    }
    if ((hourRow?.count ?? 0) >= limits.perHour) {
      throw new AiRateLimited(
        "You have reached the hourly AI limit. Try again later.",
        new Date(hourStart.getTime() + HOUR_MS),
      );
    }
    if ((await countOf(tx, userId, "day", dayStart)) >= limits.perDay) {
      throw new AiRateLimited(
        "You have reached today's AI limit. It resets at midnight UTC.",
        new Date(dayStart.getTime() + DAY_MS),
      );
    }
    if ((await countOf(tx, "global", "day", dayStart)) >= limits.globalPerDay) {
      throw new AiRateLimited(
        "AI help has reached its daily limit for everyone. It resets at midnight UTC.",
        new Date(dayStart.getTime() + DAY_MS),
      );
    }

    await bump(tx, userId, "minute", minuteStart);
    await bump(tx, userId, "day", dayStart);
    await bump(tx, "global", "day", dayStart);
    await tx
      .insert(aiUsage)
      .values({ userId, windowStart: hourStart, count: 1 })
      .onConflictDoUpdate({
        target: [aiUsage.userId, aiUsage.windowStart],
        set: { count: sql`${aiUsage.count} + 1` },
      });

    // Housekeeping; the window_start indexes keep these cheap.
    await tx
      .delete(aiRateWindows)
      .where(lt(aiRateWindows.windowStart, new Date(now.getTime() - 3 * DAY_MS)));
    await tx.delete(aiUsage).where(lt(aiUsage.windowStart, new Date(now.getTime() - 48 * HOUR_MS)));

    const [lease] = await tx
      .insert(aiCallLeases)
      .values({
        userId,
        route: input.route,
        expiresAt: new Date(now.getTime() + LEASE_TTL_MS),
      })
      .returning({ id: aiCallLeases.id });
    if (isProbe) {
      await tx
        .update(aiProviderState)
        .set({ probeLeaseId: lease!.id })
        .where(eq(aiProviderState.id, 1));
    }
    return { leaseId: lease!.id, isProbe };
  });
}

/** Frees the lease. Releasing twice, or someone else's lease id, changes nothing. */
export async function releaseAiOperation(db: Database, admission: Admission): Promise<void> {
  await db.delete(aiCallLeases).where(eq(aiCallLeases.id, admission.leaseId));
  if (admission.isProbe) {
    // A trial that ended without settling the question (say, a timeout) lets the next one try.
    await db
      .update(aiProviderState)
      .set({ probeLeaseId: null })
      .where(and(eq(aiProviderState.id, 1), eq(aiProviderState.probeLeaseId, admission.leaseId)));
  }
}

/** The provider said it is out of quota. Pauses AI once this happens twice in a short time. */
export async function recordQuotaError(
  db: Database,
  admission: Admission,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const state = await lockState(tx);
    const recent =
      state.lastQuotaErrorAt !== null &&
      now.getTime() - state.lastQuotaErrorAt.getTime() <= QUOTA_STREAK_WINDOW_MS;
    const streak = recent ? state.quotaErrorStreak + 1 : 1;
    // A failed trial pauses again straight away.
    const pause = admission.isProbe || streak >= QUOTA_STREAK_TO_PAUSE;
    await tx
      .update(aiProviderState)
      .set({
        quotaErrorStreak: streak,
        lastQuotaErrorAt: now,
        pausedUntil: pause ? new Date(now.getTime() + PAUSE_MS) : state.pausedUntil,
      })
      .where(eq(aiProviderState.id, 1));
  });
}

/** A provider call worked: the quota problem is over. */
export async function recordProviderSuccess(db: Database): Promise<void> {
  await db
    .update(aiProviderState)
    .set({ quotaErrorStreak: 0, lastQuotaErrorAt: null, pausedUntil: null, probeLeaseId: null })
    .where(
      and(
        eq(aiProviderState.id, 1),
        sql`(${aiProviderState.quotaErrorStreak} > 0 or ${aiProviderState.pausedUntil} is not null)`,
      ),
    );
}

/** `pausedUntil` is set while paused and stays set (in the past) until a trial succeeds. */
export async function readPausedUntil(db: Database): Promise<Date | null> {
  const [row] = await db
    .select({ pausedUntil: aiProviderState.pausedUntil })
    .from(aiProviderState)
    .where(eq(aiProviderState.id, 1));
  return row?.pausedUntil ?? null;
}
