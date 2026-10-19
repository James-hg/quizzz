// Fails if a secret value or a client-exposed key variable appears in browser-visible output.
// Usage: GEMINI_API_KEY=<sentinel> npm run build && node scripts/check-bundle.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SECRET_ENV_NAMES = ["GEMINI_API_KEY", "BETTER_AUTH_SECRET", "DATABASE_URL"];
const BROWSER_DIRS = [".next/static"];
const BROWSER_FILE = /\.(html|rsc|js|css|json|txt|map)$/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (BROWSER_FILE.test(name)) yield full;
  }
}

export function scan({ roots, secrets, patterns }) {
  const problems = [];
  for (const root of roots) {
    for (const file of walk(root)) {
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
  const problems = scan({
    roots: BROWSER_DIRS,
    secrets,
    patterns: [/VITE_GEMINI/, /NEXT_PUBLIC_[A-Z_]*(KEY|SECRET|TOKEN)/],
  });
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("Bundle check passed: no secrets in browser-visible output.");
}
