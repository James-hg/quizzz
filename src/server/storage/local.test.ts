import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "./local";
import { StorageKeyError, StorageNotFoundError } from "./types";

let dir: string;
let storage: LocalStorageAdapter;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "quizzz-storage-"));
  storage = new LocalStorageAdapter(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("LocalStorageAdapter", () => {
  it("stores, reads, checks and deletes a file", async () => {
    const key = await storage.put(Buffer.from("hello"));
    expect(await storage.exists(key)).toBe(true);
    expect((await storage.get(key)).toString()).toBe("hello");
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.get(key)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("generates random keys that contain no user-controlled names", async () => {
    const a = await storage.put(Buffer.from("x"));
    const b = await storage.put(Buffer.from("x"));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{2}\/[0-9a-f-]{36}$/);
  });

  it("deleting a missing key is a no-op", async () => {
    await expect(storage.delete("aa/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).resolves.toBeUndefined();
  });

  it.each(["../etc/passwd", "/etc/passwd", "aa/../../x", "notes.docx", "", "aa/bb", "a\\b"])(
    "rejects the unsafe key %j",
    async (key) => {
      await expect(storage.get(key)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.delete(key)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.exists(key)).rejects.toBeInstanceOf(StorageKeyError);
    },
  );

  it("writes only inside its base directory", async () => {
    await storage.put(Buffer.from("x"));
    const top = await readdir(dir);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatch(/^[0-9a-f]{2}$/);
  });
});
