import type { OwnerQuestionView, RewriteContent } from "@/lib/client/types";

/** A question as the rewrite panels compare it: what it asks and what counts as the answer. */
export function contentFromQuestion(q: OwnerQuestionView): RewriteContent {
  const base = {
    type: q.type,
    prompt: q.prompt,
    codeSnippet: q.codeSnippet,
    explanation: q.explanation,
  };
  const key = q.answerKey;
  if (key.kind === "options")
    return { ...base, options: q.options, correctOptionIds: key.correctOptionIds };
  if (key.kind === "text") return { ...base, accepted: key.accepted };
  if (key.kind === "blanks") return { ...base, blanks: key.blanks };
  return { ...base, options: q.options };
}

/** What differs between the original and a proposal, so the panel can highlight it. */
export function changedParts(before: RewriteContent, after: RewriteContent) {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return {
    prompt: !same(before.prompt, after.prompt),
    code: !same(before.codeSnippet, after.codeSnippet),
    options: !same(before.options, after.options),
    answer:
      !same(before.correctOptionIds, after.correctOptionIds) ||
      !same(before.accepted, after.accepted) ||
      !same(before.blanks, after.blanks),
    explanation: !same(before.explanation, after.explanation),
  };
}
