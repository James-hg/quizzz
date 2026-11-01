import { describe, expect, it } from "vitest";
import {
  checkCorrectOptionCount,
  checkExcerptFidelity,
  checkExplanationAgreement,
  checkImportedKey,
  checkSchema,
  checkSourceIds,
  checkSupportedType,
  failedRequired,
  keyConflict,
  normalizeText,
  sameKey,
  type CitedSegment,
} from "./checks";

const opts = [
  { id: "a", text: "A" },
  { id: "b", text: "B" },
  { id: "c", text: "C" },
];
const single = (correctOptionIds: string[], explanation?: string) =>
  ({ type: "mcq_single", prompt: "Q", options: opts, correctOptionIds, explanation }) as const;

describe("schema_valid and supported_type", () => {
  it("passes well-formed content", () => {
    expect(checkSchema(single(["a"])).result).toBe("pass");
  });

  it.each([
    ["two correct options on a single-choice question", single(["a", "b"])],
    ["a correct id that is not an option", single(["z"])],
    ["an unknown type", { type: "essay", prompt: "Q" }],
    ["missing fields", { type: "mcq_single" }],
  ])("fails %s", (_l, content) => {
    const r = checkSchema(content);
    expect(r.result).toBe("fail");
    expect(r.reasonCode).toBe("schema_invalid");
  });

  it("reports where the problem is, without echoing the content", () => {
    const r = checkSchema({ ...single(["a", "b"]), prompt: "secret prompt text" });
    expect(JSON.stringify(r)).not.toContain("secret prompt text");
    expect(r.details?.paths).toContain("correctOptionIds");
  });

  it("accepts the five supported types and rejects others", () => {
    for (const t of [
      "mcq_single",
      "mcq_multi",
      "short_answer",
      "fill_blank",
      "output_prediction",
    ]) {
      expect(checkSupportedType(t).result).toBe("pass");
    }
    expect(checkSupportedType("essay").result).toBe("fail");
    expect(checkSupportedType(undefined).result).toBe("fail");
  });
});

describe("correct_option_count", () => {
  it.each([
    ["single with one", { ...single(["a"]) }, "pass"],
    ["single with two", single(["a", "b"]), "fail"],
    ["single with none", single([]), "fail"],
    ["single with an unknown id", single(["q"]), "fail"],
    ["single with a repeated id", single(["a", "a"]), "fail"],
    ["multi with two", { ...single(["a", "b"]), type: "mcq_multi" }, "pass"],
    ["multi with none", { ...single([]), type: "mcq_multi" }, "fail"],
    ["a text question", { type: "short_answer" }, "not_applicable"],
  ] as const)("%s", (_l, content, result) => {
    expect(checkCorrectOptionCount(content as never).result).toBe(result);
  });

  it("fails duplicate option ids", () => {
    const r = checkCorrectOptionCount({
      type: "mcq_single",
      options: [{ id: "a" }, { id: "a" }],
      correctOptionIds: ["a"],
    });
    expect(r).toMatchObject({ result: "fail", reasonCode: "duplicate_option_ids" });
  });
});

const seg = (over: Partial<CitedSegment> = {}): CitedSegment => ({
  id: "s1",
  text: "Closures capture   variables\nfrom the enclosing scope.",
  allowed: true,
  excerpt: null,
  ...over,
});

describe("source_ids", () => {
  it("is not applicable without citations, never a pass", () => {
    expect(checkSourceIds([], [])).toMatchObject({ result: "not_applicable" });
  });
  it("passes when every cited id is found and allowed", () => {
    expect(checkSourceIds(["s1"], [seg()]).result).toBe("pass");
  });
  it.each([
    ["a fabricated id", ["s1", "ghost"], [seg()]],
    ["a foreign or other-course segment", ["s1"], [seg({ allowed: false })]],
    ["only fabricated ids", ["ghost"], []],
  ])("fails %s", (_l, ids, found) => {
    expect(checkSourceIds(ids, found).result).toBe("fail");
  });
});

describe("excerpt_fidelity", () => {
  it("is not applicable with no quotes", () => {
    expect(checkExcerptFidelity([seg()]).result).toBe("not_applicable");
  });
  it("passes a quote that differs only in case and whitespace", () => {
    expect(
      checkExcerptFidelity([
        seg({ excerpt: "closures CAPTURE variables from the enclosing scope" }),
      ]).result,
    ).toBe("pass");
  });
  it("matches across Unicode forms", () => {
    expect(
      checkExcerptFidelity([seg({ text: "café au lait", excerpt: "café au lait" })]).result,
    ).toBe("pass");
  });
  it("fails a quote that is not in the passage", () => {
    const r = checkExcerptFidelity([seg({ excerpt: "closures copy variables" })]);
    expect(r).toMatchObject({ result: "fail", reasonCode: "excerpt_not_in_passage" });
  });
  it("does not check quotes against passages the user may not use", () => {
    expect(checkExcerptFidelity([seg({ allowed: false, excerpt: "anything" })]).result).toBe(
      "not_applicable",
    );
  });
});

describe("explanation_answer_agreement", () => {
  const content = (explanation: string | undefined, ids = ["b"]) =>
    ({ ...single(ids, explanation), explanation }) as never;

  it.each([
    ["The answer is B because...", "pass"],
    ["Correct answer: (B)", "pass"],
    ["Answer = option b", "pass"],
    ["The answer is A.", "fail"],
    ["Answer: C", "fail"],
  ])("%s -> %s", (explanation, result) => {
    expect(checkExplanationAgreement(content(explanation)).result).toBe(result);
  });

  it("is not applicable for prose with no explicit answer, or no explanation", () => {
    expect(checkExplanationAgreement(content("Closures capture scope.")).result).toBe(
      "not_applicable",
    );
    expect(checkExplanationAgreement(content(undefined)).result).toBe("not_applicable");
    expect(checkExplanationAgreement(content("  ")).result).toBe("not_applicable");
  });

  it("is not applicable when the reference is not one of the options", () => {
    expect(checkExplanationAgreement(content("The answer is Z")).result).toBe("not_applicable");
  });

  it("compares a quoted answer with the accepted answers of a text question", () => {
    const text = (explanation: string) =>
      ({
        type: "short_answer",
        prompt: "Q",
        accepted: ["Closure"],
        caseSensitive: false,
        explanation,
      }) as never;
    expect(checkExplanationAgreement(text('The answer is "closure".')).result).toBe("pass");
    expect(checkExplanationAgreement(text('The answer is "generator".')).result).toBe("fail");
    expect(checkExplanationAgreement(text("It is a closure.")).result).toBe("not_applicable");
  });
});

describe("imported_key_agreement", () => {
  const opt = (ids: string[]) => ({ kind: "options" as const, correctOptionIds: ids });
  it("has nothing to compare without an imported key", () => {
    expect(checkImportedKey(null, opt(["a"])).result).toBe("not_applicable");
    expect(checkImportedKey({ kind: "unresolved" }, opt(["a"])).result).toBe("not_applicable");
  });
  it("passes when the key is the same, in any order", () => {
    expect(checkImportedKey(opt(["a", "b"]), opt(["b", "a"])).result).toBe("pass");
  });
  it("flags a different key", () => {
    const r = checkImportedKey(opt(["a"]), opt(["b"]));
    expect(r).toMatchObject({ result: "fail", reasonCode: "differs_from_imported_key" });
    expect(keyConflict([r])).toBe(true);
  });
  it("compares text keys ignoring case when the key ignores case", () => {
    const a = { kind: "text" as const, accepted: ["Python"], caseSensitive: false };
    const b = { kind: "text" as const, accepted: [" python "], caseSensitive: false };
    expect(sameKey(a, b)).toBe(true);
    expect(sameKey(a, { ...b, accepted: ["java"] })).toBe(false);
  });
  it("compares blanks position by position", () => {
    const k = (blanks: string[][]) => ({ kind: "blanks" as const, blanks, caseSensitive: false });
    expect(sameKey(k([["a"], ["b"]]), k([["a"], ["b"]]))).toBe(true);
    expect(sameKey(k([["a"], ["b"]]), k([["b"], ["a"]]))).toBe(false);
  });
  it("is not a required check: a conflict is for the owner to explain, not a hard failure", () => {
    const r = checkImportedKey(opt(["a"]), opt(["b"]));
    expect(failedRequired([r])).toEqual([]);
  });
});

describe("helpers", () => {
  it("normalizes whitespace, case and Unicode", () => {
    expect(normalizeText("  Hello \n\t World ")).toBe("hello world");
  });
  it("lists failed required checks only", () => {
    expect(
      failedRequired([
        { name: "schema_valid", result: "fail" },
        { name: "source_ids", result: "pass" },
        { name: "excerpt_fidelity", result: "not_applicable" },
        { name: "imported_key_agreement", result: "fail" },
      ]).map((r) => r.name),
    ).toEqual(["schema_valid"]);
  });
});
