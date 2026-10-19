import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("stored files are not web-reachable", () => {
  it("has no public/ directory, so nothing on disk is served as a static asset", () => {
    expect(existsSync(path.join(root, "public"))).toBe(false);
  });

  it("defaults STORAGE_DIR outside the app source and gitignores it", () => {
    const example = readFileSync(path.join(root, ".env.example"), "utf8");
    expect(example).toMatch(/^STORAGE_DIR=\.\/storage$/m);
    const ignore = readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(ignore).toMatch(/^\/storage\/$/m);
  });

  it("exposes no API route under a storage path", () => {
    expect(existsSync(path.join(root, "src/app/storage"))).toBe(false);
    expect(existsSync(path.join(root, "src/app/api/storage"))).toBe(false);
  });
});
