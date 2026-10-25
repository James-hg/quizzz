// Fails if a secret value or a client-exposed key variable appears in browser-visible output.
// Usage: GEMINI_API_KEY=<sentinel> npm run build && node scripts/check-bundle.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SECRET_ENV_NAMES = ["GEMINI_API_KEY", "BETTER_AUTH_SECRET", "DATABASE_URL"];

// Everything under .next/static is downloaded by browsers.
const STATIC_FILES = /\.(html|rsc|js|css|json|txt|map)$/;
// Prerendered pages are served as-is. Only these files reach the browser: .html and .rsc
// (including *.segments/**/*.segment.rsc), .body for static route handlers, and .meta, which
// holds the response headers. Server chunks (.js), traces and manifests (.json) and .map files
// under .next/server stay on the server and may legitimately mention environment variable names.
const PRERENDERED_FILES = /\.(html|rsc|body|meta)$/;

/**
 * Where browser-delivered files live, relative to `base` (the project root).
 * `required` roots must contain at least one matching file, otherwise the check would pass
 * without having looked at anything.
 */
export function browserRoots(base = ".") {
  return [
    { dir: path.join(base, ".next/static"), files: STATIC_FILES, required: true },
    { dir: path.join(base, ".next/server/app"), files: PRERENDERED_FILES, required: true },
  ];
}

function normalize(root) {
  return typeof root === "string" ? { dir: root, files: STATIC_FILES, required: false } : root;
}

function* walk(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full, files);
    else if (files.test(name)) yield full;
  }
}

/** Number of files that would be scanned in each root, so an empty root can be reported. */
export function countFiles(roots) {
  return roots.map(normalize).map((root) => ({
    dir: root.dir,
    required: Boolean(root.required),
    count: [...walk(root.dir, root.files)].length,
  }));
}

/** Required roots that contain nothing to scan (missing build output, or a moved folder). */
export function emptyRequiredRoots(roots) {
  return countFiles(roots).filter((root) => root.required && root.count === 0);
}

export function scan({ roots, secrets, patterns }) {
  const problems = [];
  for (const root of roots.map(normalize)) {
    for (const file of walk(root.dir, root.files)) {
      const text = readFileSync(file, "utf8");
      for (const secret of secrets) {
        if (text.includes(secret)) problems.push(`${file}: contains a secret value`);
      }
      for (const pattern of patterns) {
        if (pattern.test(text)) problems.push(`${file}: matches ${pattern}`);
      }
    }
  }
  return problems;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const secrets = SECRET_ENV_NAMES.map((name) => process.env[name]).filter(
    (value) => value && value.length >= 8,
  );
  if (!secrets.some((value) => value === process.env.GEMINI_API_KEY)) {
    console.warn("GEMINI_API_KEY is not set (or too short); the key-value check is skipped.");
  }
  const roots = browserRoots();

  const empty = emptyRequiredRoots(roots);
  if (empty.length > 0) {
    console.error(
      `Nothing to scan in: ${empty.map((r) => r.dir).join(", ")}. Run \`npm run build\` first; ` +
        "if the build ran, Next.js may have moved its output and this check needs updating.",
    );
    process.exit(1);
  }

  const problems = scan({
    roots,
    secrets,
    patterns: [/VITE_GEMINI/, /NEXT_PUBLIC_[A-Z_]*(KEY|SECRET|TOKEN)/],
  });
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  const total = countFiles(roots).reduce((sum, r) => sum + r.count, 0);
  console.log(`Bundle check passed: scanned ${total} browser-visible files, no secrets found.`);
}
