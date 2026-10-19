// Copies sample courses into a user's account: npm run samples:load -- <language|all> --email <email>
import { eq } from "drizzle-orm";
import { getDb } from "../src/server/db";
import { user } from "../src/server/db/schema";
import { getEnv } from "../src/server/env";
import { readSamples, resolveSamplesDir } from "../src/server/samples/directory";
import { loadSample } from "../src/server/samples/loader";
import { getStorage } from "../src/server/storage";

const args = process.argv.slice(2);
const emailAt = args.indexOf("--email");
const email = emailAt >= 0 ? args[emailAt + 1] : undefined;
const target = args.find((a, i) => !a.startsWith("--") && i !== emailAt + 1);
if (!email || !target) {
  console.error("Usage: npm run samples:load -- <language|all> --email <email>");
  process.exit(1);
}

const db = getDb();
const [owner] = await db
  .select({ id: user.id })
  .from(user)
  .where(eq(user.email, email.toLowerCase()));
if (!owner) {
  console.error(`No user with email ${email}. Sign up in the app first.`);
  process.exit(1);
}

const { samples, problems } = await readSamples(resolveSamplesDir(getEnv().SAMPLES_DIR));
if (problems.length > 0) {
  console.error("Some samples are invalid; run npm run samples:validate.");
  process.exit(1);
}
const chosen = target === "all" ? samples : samples.filter((s) => s.language === target);
if (chosen.length === 0) {
  console.log(
    target === "all" ? "No sample courses to load." : `No sample course for "${target}".`,
  );
  process.exit(target === "all" ? 0 : 1);
}
for (const sample of chosen) {
  const result = await loadSample(db, getStorage(), owner.id, sample);
  console.log(
    `${sample.language}: ${result.alreadyLoaded ? "already loaded" : `loaded ${result.questionCount} questions`} (course ${result.courseId})`,
  );
}
process.exit(0);
