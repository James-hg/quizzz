import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { POST as authPost } from "@/app/api/auth/[...all]/route";
import { purgeQuestionSets } from "@/server/content/history";
import type { Database } from "@/server/db";
import {
  attempts,
  courses,
  questionImages,
  questionSets,
  sourceDocuments,
  studySessions,
  user,
} from "@/server/db/schema";
import { authRequest, cookieFrom } from "./auth-helpers";

export type TestUser = { id: string; email: string; cookie: string };

/** Signs up a fresh user through the real auth route. */
export async function signUpUser(db: Database): Promise<TestUser> {
  const email = `${randomUUID()}@example.test`;
  const response = await authPost(
    authRequest("/api/auth/sign-up/email", {
      body: { email, password: "correct horse", name: "Tester" },
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed: ${response.status}`);
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  return { id: row!.id, email, cookie: cookieFrom(response) };
}

/** Test-only teardown: attempts are normally permanent, so remove them explicitly. */
export async function deleteUsers(db: Database, userIds: string[]) {
  if (userIds.length === 0) return;
  await db.delete(attempts).where(inArray(attempts.userId, userIds));
  await db.delete(studySessions).where(inArray(studySessions.userId, userIds));
  const sets = await db
    .select({ id: questionSets.id })
    .from(questionSets)
    .where(inArray(questionSets.ownerId, userIds));
  await purgeQuestionSets(
    db,
    sets.map((s) => s.id),
  );
  await db.delete(sourceDocuments).where(inArray(sourceDocuments.ownerId, userIds));
  await db.delete(courses).where(inArray(courses.ownerId, userIds));
  await db.delete(questionImages).where(inArray(questionImages.ownerId, userIds));
  await db.delete(user).where(inArray(user.id, userIds));
}
