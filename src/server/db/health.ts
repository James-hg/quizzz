import "server-only";
import { sql } from "drizzle-orm";
import type { Database } from "./index";

export async function checkDb(db: Database): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
