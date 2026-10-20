import "server-only";
import { getEnv } from "@/server/env";
import { notFound } from "@/server/http/errors";
import {
  describeProblem,
  readSample,
  readSamples,
  resolveSamplesDir,
  summarize,
} from "./directory";

const samplesDir = () => resolveSamplesDir(getEnv().SAMPLES_DIR);

/** Valid samples only. Broken ones are logged for the maintainer (CI also fails on them). */
export async function listAvailableSamples() {
  const { samples, problems } = await readSamples(samplesDir());
  for (const problem of problems)
    console.error(`Sample course skipped:\n${describeProblem(problem)}`);
  return samples.map(summarize);
}

export async function getSampleOrThrow(language: string) {
  const sample = await readSample(samplesDir(), language);
  if (!sample) throw notFound("Sample course not found");
  return sample;
}
