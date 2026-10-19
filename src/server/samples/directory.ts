import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { courseLanguageSchema, type SampleCourse } from "@/lib/schemas";
import { formatIssue, parseSampleCourse, type SampleIssue } from "./parse";

export const SAMPLE_FILE = "course.yaml";
export const DEFAULT_SAMPLES_DIR = "fixtures/sample-courses";

export type SampleEntry = {
  language: SampleCourse["course"]["language"];
  file: string;
  raw: Buffer;
  course: SampleCourse;
};

export type SampleProblem = { file: string; issues: SampleIssue[] };

export function resolveSamplesDir(configured?: string): string {
  return path.resolve(process.cwd(), configured ?? DEFAULT_SAMPLES_DIR);
}

export function describeProblem(problem: SampleProblem): string {
  return problem.issues.map((issue) => formatIssue(problem.file, issue)).join("\n");
}

async function readEntry(root: string, name: string): Promise<SampleEntry | SampleProblem> {
  const file = path.join(root, name, SAMPLE_FILE);
  const display = path.relative(process.cwd(), file) || file;
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch {
    return { file: display, issues: [{ path: "(file)", message: `missing ${SAMPLE_FILE}` }] };
  }
  const language = courseLanguageSchema.safeParse(name);
  if (!language.success) {
    return {
      file: display,
      issues: [
        {
          path: "(directory)",
          message: `directory name must be a language: ${courseLanguageSchema.options.join(", ")}`,
        },
      ],
    };
  }
  const parsed = parseSampleCourse(raw.toString("utf8"));
  if (!parsed.ok) return { file: display, issues: parsed.issues };
  if (parsed.course.course.language !== language.data) {
    return {
      file: display,
      issues: [
        {
          path: "course.language",
          message: `is "${parsed.course.course.language}" but the directory is "${name}"`,
        },
      ],
    };
  }
  return { language: language.data, file: display, raw, course: parsed.course };
}

/**
 * Reads every `<root>/<language>/course.yaml`. Directories starting with "_" or "." (such as
 * `_template`) are skipped. A missing root means no samples, not an error.
 */
export async function readSamples(
  root: string,
): Promise<{ samples: SampleEntry[]; problems: SampleProblem[] }> {
  let names: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    names = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return { samples: [], problems: [] };
  }
  const samples: SampleEntry[] = [];
  const problems: SampleProblem[] = [];
  for (const name of names) {
    const result = await readEntry(root, name);
    if ("course" in result) samples.push(result);
    else problems.push(result);
  }
  return { samples, problems };
}

export async function readSample(root: string, language: string): Promise<SampleEntry | undefined> {
  const parsed = courseLanguageSchema.safeParse(language);
  if (!parsed.success) return undefined;
  const { samples } = await readSamples(root);
  return samples.find((s) => s.language === parsed.data);
}

export function summarize(sample: SampleEntry) {
  const { course, questions, sections } = sample.course;
  return {
    language: sample.language,
    title: course.title,
    subject: course.subject,
    sectionCount: sections.length,
    questionCount: questions.length,
    checkedQuestionCount: questions.filter((q) => q.provenance).length,
  };
}
