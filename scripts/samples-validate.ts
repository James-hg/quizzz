// Validates every sample course fixture (and the template). Exits 1 on any problem.
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SAMPLES_DIR,
  describeProblem,
  readSamples,
  resolveSamplesDir,
} from "../src/server/samples/directory";
import { formatIssue, parseSampleCourse } from "../src/server/samples/parse";

const root = resolveSamplesDir(process.env.SAMPLES_DIR);
const { samples, problems } = await readSamples(root);

// The template must always be valid, so the documented format cannot drift.
const templateFile = path.join(root, "_template", "course.yaml");
const templateIssues: string[] = [];
try {
  const result = parseSampleCourse(await readFile(templateFile, "utf8"));
  if (!result.ok) {
    templateIssues.push(
      ...result.issues.map((i) => formatIssue(path.relative(process.cwd(), templateFile), i)),
    );
  }
} catch {
  // No template (e.g. SAMPLES_DIR points elsewhere): nothing to check.
}

for (const sample of samples) {
  const checked = sample.course.questions.filter((q) => q.provenance).length;
  console.log(
    `ok  ${sample.file}  ${sample.course.questions.length} questions (${checked} with provenance)`,
  );
}
if (samples.length === 0 && problems.length === 0) {
  console.log(
    `No sample courses in ${path.relative(process.cwd(), root) || DEFAULT_SAMPLES_DIR} (that is fine).`,
  );
}

const failures = [...problems.map(describeProblem), ...templateIssues];
if (failures.length > 0) {
  console.error(`\n${failures.join("\n")}`);
  process.exit(1);
}
