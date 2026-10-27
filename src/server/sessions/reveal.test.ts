import { describe, expect, it } from "vitest";
import { disclosureFor, shouldRequeue, type Disclosure, type RevealMode } from "./reveal";

type Outcome = "correct" | "incorrect" | "uncertain";
const D = (
  mode: RevealMode,
  pass: 1 | 2,
  outcome: Outcome,
  over: { sessionEnded?: boolean; retryAnswered?: boolean } = {},
): Disclosure =>
  disclosureFor({ mode, pass, outcome, sessionEnded: false, retryAnswered: false, ...over });

describe("disclosureFor", () => {
  it("each: always everything", () => {
    for (const outcome of ["correct", "incorrect", "uncertain"] as const) {
      expect(D("each", 1, outcome)).toBe("full");
    }
  });

  it("end: nothing at all while the session is running, whatever the answer", () => {
    for (const outcome of ["correct", "incorrect", "uncertain"] as const) {
      expect(D("end", 1, outcome)).toBe("none");
      expect(D("end", 2, outcome)).toBe("none");
    }
  });

  it("requeue: a wrong first try shows the verdict only, until its retry is answered", () => {
    expect(D("requeue", 1, "incorrect")).toBe("verdict");
    expect(D("requeue", 1, "incorrect", { retryAnswered: true })).toBe("full");
  });

  it("requeue: right, unchecked and retry answers are shown in full", () => {
    expect(D("requeue", 1, "correct")).toBe("full");
    expect(D("requeue", 1, "uncertain")).toBe("full");
    expect(D("requeue", 2, "incorrect")).toBe("full");
    expect(D("requeue", 2, "correct")).toBe("full");
  });

  it("everything is shown once the session has ended, in every mode", () => {
    for (const mode of ["each", "end", "requeue"] as const) {
      for (const outcome of ["correct", "incorrect", "uncertain"] as const) {
        expect(D(mode, 1, outcome, { sessionEnded: true })).toBe("full");
      }
    }
  });
});

describe("shouldRequeue", () => {
  it("only a wrong first try in requeue mode is retried", () => {
    expect(shouldRequeue("requeue", 1, "incorrect")).toBe(true);
    expect(shouldRequeue("requeue", 1, "correct")).toBe(false);
    expect(shouldRequeue("requeue", 1, "uncertain")).toBe(false);
    expect(shouldRequeue("requeue", 2, "incorrect")).toBe(false);
    expect(shouldRequeue("each", 1, "incorrect")).toBe(false);
    expect(shouldRequeue("end", 1, "incorrect")).toBe(false);
  });
});
