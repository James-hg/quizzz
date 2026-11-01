// Checks existing generated and sample questions: npm run content:backfill [-- --apply]
// Without --apply it only reports. With it, check results are recorded, and approved questions
// that fail a required check are sent back to review (a new revision; nothing is deleted).
import { backfillContentChecks } from "../src/server/content-checks/backfill";
import { getDb } from "../src/server/db";

const apply = process.argv.includes("--apply");
const report = await backfillContentChecks(getDb(), { apply });
console.log(
  `${apply ? "Applied" : "Dry run"}: checked ${report.checked}, ${report.failing.length} approved but failing` +
    (apply ? `, ${report.quarantined} sent back to review.` : "."),
);
for (const f of report.failing) {
  console.log(`  question ${f.questionId}: ${f.failed.join(", ")}`);
}
process.exit(0);
