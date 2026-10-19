import YAML, { LineCounter } from "yaml";
import { crossCheckRaw, sampleCourseSchema, type SampleCourse } from "@/lib/schemas";

export type SampleIssue = { path: string; message: string; line?: number };

export type SampleParseResult =
  { ok: true; course: SampleCourse; issues: [] } | { ok: false; issues: SampleIssue[] };

function formatPath(path: PropertyKey[]): string {
  return path.reduce<string>(
    (out, part) =>
      typeof part === "number" ? `${out}[${part}]` : out ? `${out}.${String(part)}` : String(part),
    "",
  );
}

/**
 * Parses and validates a sample course fixture. Every problem is reported with the field path
 * and, when the position is known, the line in the file. Never throws on bad input.
 */
export function parseSampleCourse(text: string): SampleParseResult {
  const lineCounter = new LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter, uniqueKeys: true });

  const syntax: SampleIssue[] = doc.errors.map((error) => ({
    path: "(yaml)",
    message: error.message.split("\n")[0] ?? "invalid YAML",
    line: error.linePos?.[0].line,
  }));
  if (syntax.length > 0) return { ok: false, issues: syntax };

  const lineFor = (path: PropertyKey[]): number | undefined => {
    // Fall back to the nearest parent that exists in the document.
    for (let length = path.length; length >= 0; length--) {
      const node = doc.getIn(path.slice(0, length) as (string | number)[], true) as
        { range?: [number, number, number] | null } | undefined;
      if (node?.range) return lineCounter.linePos(node.range[0]).line;
    }
    return undefined;
  };

  const data = doc.toJS();
  const result = sampleCourseSchema.safeParse(data);
  if (result.success) return { ok: true, course: result.data, issues: [] };

  const issues: SampleIssue[] = result.error.issues.map((issue) => {
    const keys = (issue as { keys?: string[] }).keys;
    const path: PropertyKey[] =
      issue.code === "unrecognized_keys" && keys?.[0] ? [...issue.path, keys[0]] : [...issue.path];
    const message =
      issue.code === "unrecognized_keys" && keys
        ? `unknown field ${keys.map((k) => `"${k}"`).join(", ")}`
        : issue.message;
    return { path: formatPath(path) || "(root)", message, line: lineFor(path) };
  });
  // Cross-checks are skipped by Zod when a field is already invalid; run them on the raw data
  // too so one pass reports everything, without duplicating issues Zod already produced.
  const seen = new Set(issues.map((i) => `${i.path}|${i.message}`));
  for (const cross of crossCheckRaw(data)) {
    const path = formatPath(cross.path);
    if (seen.has(`${path}|${cross.message}`)) continue;
    issues.push({ path, message: cross.message, line: lineFor(cross.path) });
  }
  return { ok: false, issues };
}

export function formatIssue(file: string, issue: SampleIssue): string {
  return `${file}${issue.line ? `:${issue.line}` : ""}  ${issue.path}: ${issue.message}`;
}
