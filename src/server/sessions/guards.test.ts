import { describe, expect, it } from "vitest";
import { assertHelpAllowed } from "./guards";

describe("assertHelpAllowed", () => {
  it("refuses exams and sessions that reveal nothing until the end", () => {
    expect(() => assertHelpAllowed({ mode: "exam", revealMode: "end" })).toThrowError(
      expect.objectContaining({ status: 403, code: "help_disabled_in_exam" }),
    );
    expect(() => assertHelpAllowed({ mode: "quiz", revealMode: "end" })).toThrowError(
      expect.objectContaining({ status: 403, code: "help_disabled_in_session" }),
    );
  });

  it("allows the other modes", () => {
    expect(() => assertHelpAllowed({ mode: "quiz", revealMode: "each" })).not.toThrow();
    expect(() => assertHelpAllowed({ mode: "review", revealMode: "requeue" })).not.toThrow();
    expect(() => assertHelpAllowed({ mode: "quiz" })).not.toThrow();
  });
});
