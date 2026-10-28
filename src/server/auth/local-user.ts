import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { user } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import type { SessionUser } from "./session";

const LOCAL_EMAIL = "local@quizzz.local";

/** True when AUTH_DISABLED is on (never in production: the env check refuses that). */
export function isAuthDisabled(): boolean {
  return getEnv().AUTH_DISABLED;
}

const globalForLocal = globalThis as unknown as { __quizzzLocalUser?: Promise<SessionUser> };

async function loadLocalUser(): Promise<SessionUser> {
  const db = getDb();
  await db
    .insert(user)
    .values({ name: "Local user", email: LOCAL_EMAIL, emailVerified: true })
    .onConflictDoNothing({ target: user.email });
  const [row] = await db.select().from(user).where(eq(user.email, LOCAL_EMAIL));
  console.warn(
    "AUTH_DISABLED is on: login is skipped and everyone using this server is the built-in local user.",
  );
  return {
    id: row!.id,
    email: row!.email,
    name: row!.name,
    displayName: row!.displayName,
    timezone: row!.timezone,
  };
}

/** The one built-in user that stands in for a signed-in person while login is disabled. */
export function getLocalUser(): Promise<SessionUser> {
  globalForLocal.__quizzzLocalUser ??= loadLocalUser().catch((error) => {
    globalForLocal.__quizzzLocalUser = undefined;
    throw error;
  });
  return globalForLocal.__quizzzLocalUser;
}
