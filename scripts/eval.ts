// Runs an evaluation: npm run eval -- --task hint --provider mock
// Live Gemini runs need --provider gemini --live and are described in evals/README.md.
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { EVAL_TASKS, type EvalTask } from "../src/lib/schemas/eval";
import { runCli } from "../src/server/evals/cli";

const args = process.argv.slice(2);
const code = await runCli(args, {
  env: process.env,
  appCommit: () => {
    try {
      return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      return "unknown";
    }
  },
  writeFile: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  },
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  tasks: EVAL_TASKS as readonly EvalTask[],
});
process.exit(code);
