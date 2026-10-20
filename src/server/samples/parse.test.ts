import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatIssue, parseSampleCourse } from "./parse";

const valid = readFileSync(
  path.join(process.cwd(), "src/server/samples/__fixtures__/python/course.yaml"),
  "utf8",
);

function issuesFor(yaml: string) {
  const result = parseSampleCourse(yaml);
  expect(result.ok).toBe(false);
  return result.issues;
}

/** Replaces one exact substring of the valid fixture so each test changes a single thing. */
const edit = (from: string, to: string) => {
  expect(valid).toContain(from);
  return valid.replace(from, to);
};

describe("parseSampleCourse", () => {
  it("accepts a valid fixture and exposes questions, sections, and provenance", () => {
    const result = parseSampleCourse(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.course.course).toEqual({
      title: "Test Course (python)",
      subject: "Test subject",
      language: "python",
    });
    expect(result.course.sections.map((s) => s.id)).toEqual(["lists", "dicts"]);
    expect(result.course.questions[0]).toMatchObject({
      id: "q-checked",
      sections: ["lists"],
      content: { type: "mcq_single", correctOptionIds: ["b"] },
      provenance: { checkedBy: "Test Checker", checkedAt: "2026-01-15" },
    });
    expect(result.course.questions[1]?.provenance).toBeUndefined();
  });

  it("reports YAML syntax errors with a line", () => {
    const issues = issuesFor("format: 1\ncourse: [unclosed\n");
    expect(issues[0]?.path).toBe("(yaml)");
    expect(issues[0]?.line).toBeGreaterThan(0);
  });

  it("rejects duplicate YAML keys", () => {
    expect(issuesFor("format: 1\nformat: 1\n")[0]?.path).toBe("(yaml)");
  });

  it("points at the wrong correct option id, by path and line", () => {
    const issues = issuesFor(edit("correctOptionIds: [b]", "correctOptionIds: [z]"));
    const issue = issues.find((i) => i.path.endsWith("correctOptionIds"));
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/correct ids must match option ids/);
    expect(issue?.path).toBe("questions[0].correctOptionIds");
    expect(issue?.line).toBe(
      valid.split("\n").findIndex((l) => l.includes("correctOptionIds")) + 1,
    );
  });

  it("says a missing required field is required", () => {
    const issues = issuesFor(edit("correctOptionIds: [b]", "unrelated: 1"));
    expect(
      issues.some(
        (i) => i.path === "questions[0].correctOptionIds" && /is required/.test(i.message),
      ),
    ).toBe(true);
  });

  it("catches misspelled and misplaced fields", () => {
    const typo = issuesFor(edit("correctOptionIds: [b]", "correctOptionId: [b]"));
    expect(typo.map((i) => i.message).join("\n")).toMatch(
      /unknown field "correctOptionId" for a mcq_single question \(did you mean "correctOptionIds"\?\)/,
    );
    const misplaced = issuesFor(
      edit("    sections: [lists, dicts]", "    sections: [lists, dicts]\n    options: []"),
    );
    expect(misplaced.map((i) => i.message).join("\n")).toMatch(/unknown field "options"/);
  });

  it("rejects unknown top-level and course fields", () => {
    expect(issuesFor(valid + "\nextra: 1\n")[0]?.message).toMatch(/unknown field "extra"/);
    const course = issuesFor(
      edit("  subject: Test subject", "  subject: Test subject\n  level: 2"),
    );
    expect(course[0]?.path).toBe("course.level");
  });

  it("rejects an unsupported language, format version, and empty question list", () => {
    expect(issuesFor(edit("language: python", "language: ruby"))[0]?.path).toBe("course.language");
    expect(issuesFor(edit("format: 1", "format: 2"))[0]?.path).toBe("format");
    const noQuestions = valid.slice(0, valid.indexOf("questions:")) + "questions: []\n";
    expect(issuesFor(noQuestions).some((i) => /at least one question/.test(i.message))).toBe(true);
  });

  it("rejects unknown section references and duplicate ids", () => {
    const ref = issuesFor(edit("sections: [lists]", "sections: [missing]"));
    expect(ref[0]).toMatchObject({
      path: "questions[0].sections[0]",
      message: 'unknown section "missing"',
    });

    const dupSection = issuesFor(edit("  - id: dicts", "  - id: lists"));
    expect(dupSection.some((i) => i.message === 'duplicate section id "lists"')).toBe(true);

    const dupQuestion = issuesFor(edit("  - id: q-unchecked", "  - id: q-checked"));
    expect(dupQuestion.some((i) => i.message === 'duplicate question id "q-checked"')).toBe(true);
  });

  it("validates provenance precisely", () => {
    expect(issuesFor(edit("checkedAt: 2026-01-15", "checkedAt: 15/01/2026"))[0]?.message).toMatch(
      /YYYY-MM-DD/,
    );
    expect(issuesFor(edit("checkedAt: 2026-01-15", "checkedAt: 2026-02-31"))[0]?.message).toMatch(
      /not a real calendar date/,
    );
    expect(issuesFor(edit("checkedAt: 2026-01-15", "checkedAt: 2999-01-01"))[0]?.message).toMatch(
      /future/,
    );
    expect(issuesFor(edit("checkedBy: Test Checker", "checkedBy: ''"))[0]?.path).toBe(
      "questions[0].provenance.checkedBy",
    );
  });

  it("applies the editor's question rules (type-specific fields, option counts)", () => {
    const oneOption = issuesFor(edit("      - { id: a, text: Wrong }\n", ""));
    expect(oneOption.some((i) => /at least 2 options/.test(i.message))).toBe(true);
    const noAnswers = issuesFor(edit('accepted: ["answer one", "answer two"]', "accepted: []"));
    expect(noAnswers.length).toBeGreaterThan(0);
  });

  it("reports every problem, not just the first", () => {
    const issues = issuesFor(
      edit("language: python", "language: ruby").replace("sections: [lists]", "sections: [nope]"),
    );
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it("formats issues as file:line path: message", () => {
    expect(formatIssue("a.yaml", { path: "x.y", message: "bad", line: 7 })).toBe(
      "a.yaml:7  x.y: bad",
    );
    expect(formatIssue("a.yaml", { path: "x", message: "bad" })).toBe("a.yaml  x: bad");
  });

  it("never throws on odd input", () => {
    for (const input of ["", "null", "[]", "42", "- a\n- b", "{{{"]) {
      expect(() => parseSampleCourse(input)).not.toThrow();
      expect(parseSampleCourse(input).ok).toBe(false);
    }
  });
});

describe("the shipped template", () => {
  it("is a valid fixture, so the documented format cannot go stale", () => {
    const template = readFileSync(
      path.join(process.cwd(), "fixtures/sample-courses/_template/course.yaml"),
      "utf8",
    );
    const result = parseSampleCourse(template);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
