import { describe, expect, it } from "vitest";
import { evidenceFor, type EvidenceInput, type EvidenceState } from "./evidence";

const row = (
  name: string,
  input: Partial<EvidenceInput>,
  expected: EvidenceState,
): [string, Partial<EvidenceInput>, EvidenceState] => [name, input, expected];

describe("evidenceFor", () => {
  it.each([
    row("owner question with an answer, no tick", { origin: "original" }, "human_reviewed"),
    row(
      "owner question with an answer, ticked",
      { origin: "original", approve: true },
      "human_reviewed",
    ),
    row(
      "editing an owner question that was unresolved",
      { origin: "original", previous: "unresolved" },
      "human_reviewed",
    ),
    row(
      "missing answer is unresolved",
      { origin: "original", answerKind: "unresolved" },
      "unresolved",
    ),
    row(
      "missing answer is unresolved even for AI and approve",
      { origin: "ai_proposed", answerKind: "unresolved", approve: true },
      "unresolved",
    ),
    row("AI-proposed, approved", { origin: "ai_proposed", approve: true }, "human_reviewed"),
    row(
      "AI-proposed, edited without approval",
      { origin: "ai_proposed", previous: "generated_unreviewed" },
      "generated_unreviewed",
    ),
    row(
      "AI variant, edited without approval",
      { origin: "ai_variant", previous: "needs_review" },
      "needs_review",
    ),
    row(
      "sample, edited without approval",
      { origin: "sample", previous: "needs_review" },
      "needs_review",
    ),
    row(
      "sample, approved",
      { origin: "sample", previous: "needs_review", approve: true },
      "human_reviewed",
    ),
    row(
      "rejected stays rejected until approved",
      { origin: "sample", previous: "rejected" },
      "rejected",
    ),
    row(
      "a checked sample edited without approval is checked again",
      { origin: "sample", previous: "human_reviewed" },
      "needs_review",
    ),
    row("no earlier state for a non-original question", { origin: "sample" }, "needs_review"),
  ])("%s", (_name, input, expected) => {
    const full: EvidenceInput = {
      origin: "original",
      answerKind: "options",
      approve: false,
      ...input,
    };
    expect(evidenceFor(full)).toBe(expected);
  });

  it("never depends on approve for original questions with an answer", () => {
    for (const approve of [true, false]) {
      expect(evidenceFor({ origin: "original", answerKind: "text", approve })).toBe(
        "human_reviewed",
      );
    }
  });
});
