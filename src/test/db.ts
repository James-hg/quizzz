import { afterAll, afterEach, beforeEach } from "vitest";
import { createDb, type Database } from "@/server/db";

class Rollback extends Error {}

/**
 * Gives each test its own transaction that is always rolled back.
 * Usage: `const tx = withTestTransaction();` then `await tx().execute(...)`.
 */
export function withTestTransaction(): () => Database {
  const handle = createDb(process.env.TEST_DATABASE_URL!, 1);
  let current: Database | undefined;
  let finish: (() => void) | undefined;
  let done: Promise<unknown> | undefined;

  beforeEach(async () => {
    const ready = new Promise<Database>((resolve) => {
      done = handle.db
        .transaction(async (tx) => {
          resolve(tx as unknown as Database);
          await new Promise<void>((release) => (finish = release));
          throw new Rollback();
        })
        .catch((error) => {
          if (!(error instanceof Rollback)) throw error;
        });
    });
    current = await ready;
  });

  afterEach(async () => {
    finish?.();
    await done;
    current = undefined;
  });

  afterAll(async () => {
    await handle.client.end();
  });

  return () => {
    if (!current) throw new Error("No active test transaction");
    return current;
  };
}
