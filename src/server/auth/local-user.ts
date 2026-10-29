import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { user } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import type { SessionUser } from "./session";

/** How the local user is found again after a restart, so its email must never change. */
export const LOCAL_EMAIL = "local@quizzz.local";

/** True when AUTH_DISABLED is on (never in production: the env check refuses that). */
export function isAuthDisabled(): boolean {
  return getEnv().AUTH_DISABLED;
}

const globalForLocal = globalThis as unknown as { __quizzzLocalUserId?: Promise<string> };

async function ensureLocalUserId(): Promise<string> {
  const db = getDb();
  await db
    .insert(user)
    .values({ name: "Local user", email: LOCAL_EMAIL, emailVerified: true })
    .onConflictDoNothing({ target: user.email });
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, LOCAL_EMAIL));
  console.warn(
    "AUTH_DISABLED is on: login is skipped and everyone using this server is the built-in local user.",
  );
  return row!.id;
}

function localUserId(): Promise<string> {
  globalForLocal.__quizzzLocalUserId ??= ensureLocalUserId().catch((error) => {
    globalForLocal.__quizzzLocalUserId = undefined;
    throw error;
  });
  return globalForLocal.__quizzzLocalUserId;
}

async function loadById(id: string) {
  const [row] = await getDb().select().from(user).where(eq(user.id, id));
  return row;
}

/**
 * The one built-in user that stands in for a signed-in person while login is disabled. Only the
 * id is cached: the profile is read on every call, so settings changes show up immediately, the
 * same as for a signed-in user.
 */
export async function getLocalUser(): Promise<SessionUser> {
  let row = await loadById(await localUserId());
  if (!row) {
    // The row was removed while the server ran (for example a database reset): create it again.
    globalForLocal.__quizzzLocalUserId = undefined;
    row = await loadById(await localUserId());
  }
  return {
    id: row!.id,
    email: row!.email,
    name: row!.name,
    displayName: row!.displayName,
    timezone: row!.timezone,
  };
}
