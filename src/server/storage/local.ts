import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StorageKeyError, StorageNotFoundError, type StorageAdapter } from "./types";

const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Stores files on local disk under `baseDir`. Keys are random UUIDs (sharded by their first
 * two characters); user filenames never reach the filesystem. `baseDir` must be outside
 * `public/`, so nothing here is served over HTTP.
 */
export class LocalStorageAdapter implements StorageAdapter {
  private readonly root: string;

  constructor(baseDir: string) {
    this.root = path.resolve(baseDir);
  }

  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new StorageKeyError(key);
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(this.root + path.sep)) throw new StorageKeyError(key);
    return resolved;
  }

  async put(data: Uint8Array): Promise<string> {
    const id = randomUUID();
    const key = `${id.slice(0, 2)}/${id}`;
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // "wx" fails if the file exists, so a key can never overwrite another file.
    await writeFile(target, data, { flag: "wx", mode: 0o600 });
    return key;
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StorageNotFoundError(key);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(key))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
