import "server-only";
import { getEnv } from "@/server/env";
import { LocalStorageAdapter } from "./local";
import type { StorageAdapter } from "./types";

export type { StorageAdapter } from "./types";

let adapter: StorageAdapter | undefined;

/** Local disk by default. A Supabase adapter is added in Phase E. */
export function getStorage(): StorageAdapter {
  adapter ??= new LocalStorageAdapter(getEnv().STORAGE_DIR);
  return adapter;
}
