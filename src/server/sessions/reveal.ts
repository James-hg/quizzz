import type { SessionRow } from "./view";

/**
 * What a student may see about an answer, decided in one place. Results are built from this,
 * so the submit response, a replay of it, and the session view cannot disagree or leak.
 *
 * - `each`: everything after every answer.
 * - `end`: nothing until the session ends.
 * - `requeue`: the verdict after every answer, but the correct answer of a wrong first attempt
 *   stays hidden until its single retry is answered (or the session ends). Retries show all.
 */
export type RevealMode = SessionRow["revealMode"];

export type Disclosure = "full" | "verdict" | "none";

export type Pass = 1 | 2;

type Outcome = "correct" | "incorrect" | "uncertain";

export const isEnded = (state: SessionRow["state"]) =>
  state === "completed" || state === "abandoned";

export function disclosureFor(input: {
  mode: RevealMode;
  sessionEnded: boolean;
  pass: Pass;
  outcome: Outcome;
  /** For a wrong first attempt in requeue mode: has the retry been answered? */
  retryAnswered: boolean;
}): Disclosure {
  // Once the session is over there is nothing left to protect.
  if (input.sessionEnded) return "full";
  switch (input.mode) {
    case "each":
      return "full";
    case "end":
      return "none";
    case "requeue":
      if (input.pass === 1 && input.outcome === "incorrect" && !input.retryAnswered) {
        return "verdict";
      }
      return "full";
  }
}

/** A wrong first answer is retried once in requeue mode. Unchecked (uncertain) answers are not. */
export function shouldRequeue(mode: RevealMode, pass: Pass, outcome: Outcome): boolean {
  return mode === "requeue" && pass === 1 && outcome === "incorrect";
}
