import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { scan } from "./check-bundle.mjs";

const dirs: string[] = [];
function bundle(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "bundle-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  return root;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const patterns = [/VITE_GEMINI/, /NEXT_PUBLIC_[A-Z_]*(KEY|SECRET|TOKEN)/];

describe("bundle scan", () => {
  it("passes a clean bundle", () => {
    const root = bundle({ "chunks/a.js": "console.log('hello')" });
    expect(scan({ roots: [root], secrets: ["sk-test-12345678"], patterns })).toEqual([]);
  });

  it("finds a leaked secret value in nested files", () => {
    const root = bundle({ "chunks/deep/a.js": "const k='sk-test-12345678'" });
    expect(scan({ roots: [root], secrets: ["sk-test-12345678"], patterns })).toHaveLength(1);
  });

  it("finds client-exposed key variable names", () => {
    const root = bundle({
      "a.js": "process.env.NEXT_PUBLIC_GEMINI_API_KEY",
      "b.js": "VITE_GEMINI_API_KEY",
    });
    expect(scan({ roots: [root], secrets: [], patterns })).toHaveLength(2);
  });
});
