import { questionContentSchema, type QuestionContent } from "@/lib/schemas";

/**
 * Named, repeatable checks of a question. Each returns pass, fail or not_applicable; none of
 * them says a question is "verified". They find structural problems (a broken key, a citation
 * that does not exist, a quote that is not in the passage); they cannot tell whether an answer
 * is educationally correct, so the owner still decides.
 */

export const VALIDATOR_VERSION = "b6.1";

export const CHECK_NAMES = [
  "schema_valid",
  "supported_type",
  "correct_option_count",
  "source_ids",
  "excerpt_fidelity",
  "explanation_answer_agreement",
  "imported_key_agreement",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** These must not fail for a non-original question to be approved. */
export const REQUIRED_CHECKS: readonly CheckName[] = [
  "schema_valid",
  "supported_type",
  "correct_option_count",
  "source_ids",
  "excerpt_fidelity",
  "explanation_answer_agreement",
];

export type CheckResult = {
  name: CheckName;
  result: "pass" | "fail" | "not_applicable";
  /** Short machine-readable reason, safe to show. */
  reasonCode?: string;
  details?: Record<string, unknown>;
};

const pass = (name: CheckName, details?: Record<string, unknown>): CheckResult => ({
  name,
  result: "pass",
  details,
});
const fail = (
  name: CheckName,
  reasonCode: string,
  details?: Record<string, unknown>,
): CheckResult => ({ name, result: "fail", reasonCode, details });
const na = (name: CheckName, reasonCode: string): CheckResult => ({
  name,
  result: "not_applicable",
  reasonCode,
});

const SUPPORTED_TYPES = [
  "mcq_single",
  "mcq_multi",
  "short_answer",
  "fill_blank",
  "output_prediction",
] as const;

/** Whole content as the editor would send it. Unknown types fail here, not in a throw. */
export function checkSchema(content: unknown): CheckResult {
  const parsed = questionContentSchema.safeParse(content);
  if (parsed.success) return pass("schema_valid");
  return fail("schema_valid", "schema_invalid", {
    paths: [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].slice(0, 10),
  });
}

export function checkSupportedType(type: unknown): CheckResult {
  return (SUPPORTED_TYPES as readonly unknown[]).includes(type)
    ? pass("supported_type")
    : fail("supported_type", "unsupported_type");
}

/**
 * Exactly one correct option for a single-choice question, at least one for multi-choice, and every correct id must be one of the options.
 */
export function checkCorrectOptionCount(content: {
  type: string;
  options?: { id: string }[];
  correctOptionIds?: string[];
}): CheckResult {
  if (content.type !== "mcq_single" && content.type !== "mcq_multi") {
    return na("correct_option_count", "not_multiple_choice");
  }
  const ids = content.options?.map((o) => o.id) ?? [];
  const correct = content.correctOptionIds ?? [];
  if (new Set(ids).size !== ids.length) return fail("correct_option_count", "duplicate_option_ids");
  if (new Set(correct).size !== correct.length) {
    return fail("correct_option_count", "duplicate_correct_ids");
  }
  if (!correct.every((id) => ids.includes(id))) {
    return fail("correct_option_count", "unknown_correct_option", { correct: correct.length });
  }
  if (content.type === "mcq_single" && correct.length !== 1) {
    return fail("correct_option_count", "single_choice_needs_one", { correct: correct.length });
  }
  if (content.type === "mcq_multi" && correct.length < 1) {
    return fail("correct_option_count", "multi_choice_needs_one_or_more", { correct: 0 });
  }
  return pass("correct_option_count", { correct: correct.length });
}

/** Case, accents' composition and runs of whitespace do not matter when comparing a quote. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export type CitedSegment = {
  id: string;
  text: string;
  /** Owned by the question's owner and in the question's course. */
  allowed: boolean;
  excerpt: string | null;
};

/** Every cited id must exist, belong to the owner and be in the question's course. */
export function checkSourceIds(requestedIds: string[], found: CitedSegment[]): CheckResult {
  if (requestedIds.length === 0) return na("source_ids", "no_citations");
  const usable = new Set(found.filter((s) => s.allowed).map((s) => s.id));
  const missing = requestedIds.filter((id) => !usable.has(id));
  if (missing.length > 0) {
    return fail("source_ids", "unknown_or_foreign_source", { count: missing.length });
  }
  return pass("source_ids", { count: requestedIds.length });
}

/** A quoted excerpt must appear in its passage. This is a text match, not a meaning check. */
export function checkExcerptFidelity(cited: CitedSegment[]): CheckResult {
  const quoted = cited.filter((s) => s.allowed && s.excerpt && s.excerpt.trim());
  if (quoted.length === 0) return na("excerpt_fidelity", "no_excerpts");
  const bad = quoted.filter((s) => !normalizeText(s.text).includes(normalizeText(s.excerpt!)));
  if (bad.length > 0) {
    return fail("excerpt_fidelity", "excerpt_not_in_passage", { segmentIds: bad.map((s) => s.id) });
  }
  return pass("excerpt_fidelity", { count: quoted.length });
}

const OPTION_REFERENCE =
  /(?:correct\s+answers?|answers?)\s*(?:is|are|:|=)\s*(?:option\s*)?\(?([A-Za-z0-9]{1,3})\)?(?![A-Za-z0-9])/i;

const QUOTED_ANSWER = /(?:correct\s+answer|answer)\s*(?:is|:|=)\s*["“'‘]([^"”'’\n]{1,200})["”'’]/i;

/**
 * Looks for an explicit statement of the answer in the explanation ("The answer is B", "Answer: 7")
 * and compares it with the key. Free prose that states nothing explicit is not_applicable: it is
 * never guessed at.
 */
export function checkExplanationAgreement(content: QuestionContent): CheckResult {
  const name = "explanation_answer_agreement" as const;
  const explanation = content.explanation?.trim();
  if (!explanation) return na(name, "no_explanation");

  if (content.type === "mcq_single" || content.type === "mcq_multi") {
    const match = OPTION_REFERENCE.exec(explanation);
    if (!match) return na(name, "no_explicit_answer");
    const ref = match[1]!;
    const index = /^[A-Za-z]$/.test(ref) ? ref.toUpperCase().charCodeAt(0) - 65 : -1;
    const byLetter = index >= 0 ? content.options[index] : undefined;
    const byId = content.options.find((o) => o.id.toLowerCase() === ref.toLowerCase());
    const named = byLetter ?? byId;
    if (!named) return na(name, "reference_not_an_option");
    // For multi-choice, one named option must at least be among the correct ones.
    return content.correctOptionIds.includes(named.id)
      ? pass(name)
      : fail(name, "explanation_names_different_answer", { stated: ref });
  }

  if (content.type === "short_answer" || content.type === "output_prediction") {
    const match = QUOTED_ANSWER.exec(explanation);
    if (!match) return na(name, "no_explicit_answer");
    const stated = content.caseSensitive ? match[1]!.trim() : normalizeText(match[1]!);
    const ok = content.accepted.some((a) =>
      content.caseSensitive ? a.trim() === stated : normalizeText(a) === stated,
    );
    return ok ? pass(name) : fail(name, "explanation_names_different_answer");
  }
  return na(name, "no_explicit_answer");
}

export type KeyShape =
  | { kind: "options"; correctOptionIds: string[] }
  | { kind: "text"; accepted: string[]; caseSensitive: boolean }
  | { kind: "blanks"; blanks: string[][]; caseSensitive: boolean }
  | { kind: "unresolved" };

const sortedNorm = (values: string[], caseSensitive = false) =>
  values.map((v) => (caseSensitive ? v.trim() : normalizeText(v))).sort();

/** Whether two keys name the same answer. Option keys compare by option id. */
export function sameKey(a: KeyShape, b: KeyShape): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "options" && b.kind === "options") {
    return (
      JSON.stringify([...a.correctOptionIds].sort()) ===
      JSON.stringify([...b.correctOptionIds].sort())
    );
  }
  if (a.kind === "text" && b.kind === "text") {
    return (
      JSON.stringify(sortedNorm(a.accepted, a.caseSensitive)) ===
      JSON.stringify(sortedNorm(b.accepted, b.caseSensitive))
    );
  }
  if (a.kind === "blanks" && b.kind === "blanks") {
    return (
      a.blanks.length === b.blanks.length &&
      a.blanks.every(
        (alts, i) =>
          JSON.stringify(sortedNorm(alts, a.caseSensitive)) ===
          JSON.stringify(sortedNorm(b.blanks[i]!, b.caseSensitive)),
      )
    );
  }
  return true;
}

/**
 * Compares the key with the one the question had when it was imported. A difference is shown to
 * the owner, who must say why they are keeping it; the imported key itself is never changed.
 */
export function checkImportedKey(baseline: KeyShape | null, current: KeyShape): CheckResult {
  if (!baseline) return na("imported_key_agreement", "no_imported_key");
  if (baseline.kind === "unresolved" || current.kind === "unresolved") {
    return na("imported_key_agreement", "key_not_resolved");
  }
  return sameKey(baseline, current)
    ? pass("imported_key_agreement")
    : fail("imported_key_agreement", "differs_from_imported_key");
}

/** The result of the failed required checks, if any. */
export function failedRequired(results: readonly CheckResult[]): CheckResult[] {
  return results.filter((r) => r.result === "fail" && REQUIRED_CHECKS.includes(r.name));
}

export function keyConflict(results: readonly CheckResult[]): boolean {
  return results.some((r) => r.name === "imported_key_agreement" && r.result === "fail");
}
