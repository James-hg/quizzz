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
