import type { AnswerKey } from "@/lib/schemas";

/**
 * Whether a piece of help gives away the accepted answer. Used where help must stop short of the
 * answer (a small hint, and a hint during the protected retry). It checks the pinned answer key
 * only; it cannot prove a hint is safe, it can only refuse the obvious disclosures.
 */

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The answers a hint must not state, as words: option texts, accepted answers, blank values. */
export function answerPhrases(
  key: AnswerKey,
  options: { id: string; text: string }[],
): { phrases: string[]; optionIds: string[] } {
  if (key.kind === "options") {
    const correct = options.filter((o) => key.correctOptionIds.includes(o.id));
    return {
      phrases: correct.map((o) => normalize(o.text)).filter(Boolean),
      optionIds: key.correctOptionIds.map(normalize).filter(Boolean),
    };
  }
  if (key.kind === "text") {
    return { phrases: key.accepted.map(normalize).filter(Boolean), optionIds: [] };
  }
  if (key.kind === "blanks") {
    return { phrases: key.blanks.flat().map(normalize).filter(Boolean), optionIds: [] };
  }
  return { phrases: [], optionIds: [] };
}

/** True when `text` states the answer: its words, or "option B" / "the answer is B". */
export function leaksAnswer(
  text: string,
  key: AnswerKey,
  options: { id: string; text: string }[],
): boolean {
  const { phrases, optionIds } = answerPhrases(key, options);
  const haystack = ` ${normalize(text)} `;

  for (const phrase of phrases) {
    // A one-character answer ("7", "b") appears in ordinary prose, so it only counts when the
    // text says it is the answer.
    if (phrase.length === 1) {
      const stated = new RegExp(
        `\\b(?:answer|correct|result|equals?|is|choose|pick|select|option|choice)\\s+(?:is\\s+|are\\s+)?(?:option\\s+|choice\\s+)?${escape(phrase)}\\b`,
      );
      if (stated.test(haystack.trim())) return true;
      continue;
    }
    if (haystack.includes(` ${phrase} `)) return true;
  }

  for (const id of optionIds) {
    const label = escape(id);
    const stated = new RegExp(
      `\\b(?:option|choice|answer|letter|choose|pick|select)\\s+(?:is\\s+|would be\\s+|should be\\s+)?${label}\\b`,
    );
    if (stated.test(haystack.trim())) return true;
  }
  return false;
}
