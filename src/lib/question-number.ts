/**
 * Finds and removes a leading question number from an imported prompt ("1. ", "Question 3: ",
 * "(2) ", "Q4."), so numbering from the source document does not show up once questions are
 * shuffled.
 *
 * The rules are deliberately narrow. A number is only treated as numbering when it is followed by
 * a delimiter or the word "question"/"Q", and has at most three digits. So these stay as they
 * are: "2 + 2 = ?", "5 - 3 = ?", "3 apples cost 6. What is one?", "1.2 mg is how many ...", and
 * "2018. Which release ...". Word's automatic numbering is not part of the text, so there is
 * nothing to remove for it.
 *
 * Everything `QUESTION_PREFIX` strips during import (`src/server/import/mcq-detect.ts`) is also
 * stripped here, plus the forms it does not know: "Question 3:", "Q3.", "(1)".
 */

const PATTERNS: readonly RegExp[] = [
  // "Question 3", "Question 3:", "Q3.", "Q3)", "Q.3 ", "Q3 ".
  /^\s*(?:question|q)\s*\.?\s*\d{1,3}\s*[.):\-–—]?\s+(?=\S)/i,
  // "(1) ".
  /^\s*\(\s*\d{1,3}\s*\)\s+(?=\S)/,
  // "1. " and "1) ". The delimiter must be followed by whitespace, so "1.2 mg" is left alone.
  /^\s*\d{1,3}\s*[.)]\s+(?=\S)/,
];

export type StrippedPrompt = {
  /** The prompt without its number, or the input unchanged when there was none. */
  text: string;
  removed: boolean;
};

export function stripQuestionNumber(prompt: string): StrippedPrompt {
  for (const pattern of PATTERNS) {
    const match = pattern.exec(prompt);
    if (!match) continue;
    const rest = prompt.slice(match[0].length).trimStart();
    // Never leave an empty prompt behind.
    if (rest === "") return { text: prompt, removed: false };
    return { text: rest, removed: true };
  }
  return { text: prompt, removed: false };
}

export function hasQuestionNumber(prompt: string): boolean {
  return stripQuestionNumber(prompt).removed;
}

export type NumberToggle = {
  /** True when the number has already been removed from the prompt. */
  applied: boolean;
  /** The prompt with its number. */
  original: string;
  /** The prompt without its number. */
  stripped: string;
  /** The edit that flips the toggle: the new prompt, and the original to keep (or null). */
  next: { prompt: string; originalPrompt: string | null };
};

/**
 * What the review page's "Remove question number" toggle should show for an imported prompt, or
 * null when the prompt has no number to remove. `originalPrompt` is set once a number has been
 * removed, which is what lets the toggle put it back.
 */
export function numberToggleFor(
  prompt: string,
  originalPrompt?: string | null,
): NumberToggle | null {
  if (originalPrompt) {
    return {
      applied: true,
      original: originalPrompt,
      stripped: prompt,
      next: { prompt: originalPrompt, originalPrompt: null },
    };
  }
  const stripped = stripQuestionNumber(prompt);
  if (!stripped.removed) return null;
  return {
    applied: false,
    original: prompt,
    stripped: stripped.text,
    next: { prompt: stripped.text, originalPrompt: prompt },
  };
}
