import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/server/env";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

type DbHandle = { client: ReturnType<typeof postgres>; db: Database };

const globalForDb = globalThis as unknown as { __quizzzDb?: DbHandle };

/**
 * postgres.js is used because it is pure JS, supports transactions cleanly, and works with
 * Supabase's transaction pooler when prepared statements are off (`prepare: false`).
 * The small pool suits serverless; override with DB_POOL_MAX.
 */
export function createDb(url: string, max = 5): DbHandle {
  const client = postgres(url, { max, prepare: false, idle_timeout: 20, connect_timeout: 5 });
  return { client, db: drizzle(client, { schema }) };
}

/** Lazily created and cached on globalThis so dev hot reloads do not leak connections. */
export function getDb(): Database {
  globalForDb.__quizzzDb ??= createDb(getEnv().DATABASE_URL, Number(process.env.DB_POOL_MAX) || 5);
  return globalForDb.__quizzzDb.db;
}
