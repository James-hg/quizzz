import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EVAL_TASKS, evalCaseSchema, type EvalCase, type EvalTask } from "@/lib/schemas/eval";

/** A case together with where it came from, so errors and reports can point at the line. */
export type LoadedCase = { case: EvalCase; file: string; line: number };
export type LoadProblem = { file: string; line: number | null; message: string };

export type LoadResult = {
  cases: LoadedCase[];
  problems: LoadProblem[];
  /** Hash of every file read, in order, so a run records exactly which cases it used. */
  fixtureHash: string;
  files: string[];
};

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Parses one JSONL file. A bad line is reported with its number and does not hide the rest. */
export function parseJsonl(
  source: string,
  file: string,
  expect: { language: string; task: EvalTask },
): { cases: LoadedCase[]; problems: LoadProblem[] } {
  const cases: LoadedCase[] = [];
  const problems: LoadProblem[] = [];
  const seen = new Set<string>();
  source.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      problems.push({ file, line, message: "not valid JSON" });
      return;
    }
    const parsed = evalCaseSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0]!;
      problems.push({
        file,
        line,
        message: `${first.path.join(".") || "(case)"}: ${first.message}`,
      });
      return;
    }
    const value = parsed.data;
    if (value.task !== expect.task) {
      problems.push({
        file,
        line,
        message: `task "${value.task}" does not belong in ${expect.task}.jsonl`,
      });
      return;
    }
    if (value.language !== expect.language) {
      problems.push({
        file,
        line,
        message: `language "${value.language}" does not match folder "${expect.language}"`,
      });
      return;
    }
    if (seen.has(value.id)) {
      problems.push({ file, line, message: `duplicate id "${value.id}"` });
      return;
    }
    seen.add(value.id);
    cases.push({ case: value, file, line });
  });
  return { cases, problems };
}

/**
 * Reads `<dir>/<language>/<task>.jsonl`. Ids must be unique across the whole set, since results
 * are reported by id. Files that do not follow the layout are reported, not skipped silently.
 */
export function loadEvalDir(
  dir: string,
  filter: { task?: EvalTask; language?: string } = {},
): LoadResult {
  const result: LoadResult = { cases: [], problems: [], fixtureHash: "", files: [] };
  const hash = createHash("sha256");
  if (!isDir(dir)) {
    result.problems.push({ file: dir, line: null, message: "evaluation folder not found" });
    result.fixtureHash = hash.digest("hex");
    return result;
  }
  const taskFiles = new Set(EVAL_TASKS.map((t) => `${t}.jsonl`));
  for (const language of readdirSync(dir).sort()) {
    const langDir = path.join(dir, language);
    if (!isDir(langDir) || language.startsWith(".")) continue;
    if (filter.language && language !== filter.language) continue;
    for (const name of readdirSync(langDir).sort()) {
      const file = path.join(langDir, name);
      if (!name.endsWith(".jsonl")) continue;
      if (!taskFiles.has(name)) {
        result.problems.push({ file, line: null, message: `unknown task file "${name}"` });
        continue;
      }
      const task = name.replace(/\.jsonl$/, "") as EvalTask;
      if (filter.task && task !== filter.task) continue;
      const source = readFileSync(file, "utf8");
      hash.update(`${path.relative(dir, file)}\n${source}\n`);
      result.files.push(file);
      const parsed = parseJsonl(source, file, { language, task });
      result.cases.push(...parsed.cases);
      result.problems.push(...parsed.problems);
    }
  }
  const owner = new Map<string, LoadedCase>();
  result.cases = result.cases.filter((c) => {
    const earlier = owner.get(c.case.id);
    if (earlier) {
      result.problems.push({
        file: c.file,
        line: c.line,
        message: `id "${c.case.id}" is also used in ${path.basename(earlier.file)}:${earlier.line}`,
      });
      return false;
    }
    owner.set(c.case.id, c);
    return true;
  });
  result.fixtureHash = hash.digest("hex");
  return result;
}

/** How many checked cases there are per task, language and tag. Zero is reported, not hidden. */
export function coverage(cases: LoadedCase[]) {
  const table: Record<string, { total: number; tags: Record<string, number> }> = {};
  for (const { case: c } of cases) {
    const key = `${c.task}/${c.language}`;
    const row = (table[key] ??= { total: 0, tags: {} });
    row.total += 1;
    for (const tag of c.tags) row.tags[tag] = (row.tags[tag] ?? 0) + 1;
  }
  return table;
}
