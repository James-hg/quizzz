import "server-only";
import { responseSchema } from "@/lib/schemas";
import type { Database } from "../index";
import { attempts } from "../schema";

export type NewAttempt = typeof attempts.$inferInsert;

/** Validates the response jsonb, then inserts. A repeated (userId, idempotencyKey) is rejected. */
export async function insertAttempt(db: Database, input: NewAttempt) {
  const response = responseSchema.parse(input.response);
  const [row] = await db
    .insert(attempts)
    .values({ ...input, response })
    .returning();
  return row!;
}
