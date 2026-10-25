import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { browserRoots, countFiles, emptyRequiredRoots, scan } from "./check-bundle.mjs";

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

const KEY = "ci-leak-sentinel-0123456789";
const real = { secrets: [KEY], patterns };

/** A project-shaped temp dir: `.next/static` and `.next/server/app` with the given files. */
function project(files: Record<string, string>) {
  return bundle(
    Object.fromEntries(
      Object.entries(files).map(([name, content]) => [path.join(".next", name), content]),
    ),
  );
}

const CLEAN = {
  "static/chunks/app.js": "console.log('hello')",
  "server/app/_not-found.html": "<html>Not found</html>",
};

describe("bundle scan of the real roots", () => {
  it("passes a clean build", () => {
    const base = project(CLEAN);
    expect(emptyRequiredRoots(browserRoots(base))).toEqual([]);
    expect(scan({ roots: browserRoots(base), ...real })).toEqual([]);
  });

  it.each([
    "server/app/_not-found.html",
    "server/app/(app)/page.rsc",
    "server/app/_not-found.segments/_not-found/__PAGE__.segment.rsc",
    "server/app/api/static-route.body",
    "server/app/_not-found.meta",
  ])("fails when the key is in prerendered %s", (file) => {
    const base = project({ ...CLEAN, [file]: `<p>${KEY}</p>` });
    const problems = scan({ roots: browserRoots(base), ...real });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(file.split("/").pop()!);
  });

  it("fails on a client-exposed key variable in a prerendered page", () => {
    const base = project({ ...CLEAN, "server/app/index.html": "NEXT_PUBLIC_GEMINI_API_KEY" });
    expect(scan({ roots: browserRoots(base), ...real })).toHaveLength(1);
  });

  it.each([
    "server/app/(app)/page.js",
    "server/app/(app)/page_client-reference-manifest.js",
    "server/app/(app)/page.js.nft.json",
    "server/app/(app)/page.js.map",
    "server/chunks/ssr/lib.js",
  ])("ignores server-only file %s", (file) => {
    const base = project({ ...CLEAN, [file]: `process.env.X = "${KEY}"` });
    expect(scan({ roots: browserRoots(base), ...real })).toEqual([]);
  });

  it("still fails when the key is in a static chunk", () => {
    const base = project({ ...CLEAN, "static/chunks/leak.js": `k="${KEY}"` });
    expect(scan({ roots: browserRoots(base), ...real })).toHaveLength(1);
  });

  it("reports every leaking file, across both roots", () => {
    const base = project({
      ...CLEAN,
      "static/chunks/leak.js": KEY,
      "server/app/a.html": KEY,
      "server/app/b.rsc": KEY,
    });
    expect(scan({ roots: browserRoots(base), ...real })).toHaveLength(3);
  });
});

describe("empty roots", () => {
  it("flags a build with no prerendered output", () => {
    const base = project({ "static/chunks/app.js": "x" });
    expect(
      emptyRequiredRoots(browserRoots(base)).map((r: { dir: string }) => path.basename(r.dir)),
    ).toEqual(["app"]);
  });

  it("flags a missing .next folder entirely", () => {
    const base = bundle({ "README.md": "no build here" });
    expect(emptyRequiredRoots(browserRoots(base))).toHaveLength(2);
  });

  it("does not count server-only files as something scanned", () => {
    const base = project({ "static/a.js": "x", "server/app/page.js": "x" });
    const counts = countFiles(browserRoots(base));
    expect(counts.find((c: { dir: string }) => c.dir.endsWith("app"))?.count).toBe(0);
    expect(emptyRequiredRoots(browserRoots(base))).toHaveLength(1);
  });

  it("does not require roots passed as plain folders", () => {
    const root = bundle({ "a.js": "x" });
    expect(emptyRequiredRoots([root, path.join(root, "missing")])).toEqual([]);
  });
});
