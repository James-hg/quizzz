/** NFC, trim, collapse runs of whitespace; lowercase unless the question is case sensitive. */
export function normalizeText(value: string, caseSensitive: boolean): string {
  const collapsed = value.normalize("NFC").trim().replace(/\s+/g, " ");
  return caseSensitive ? collapsed : collapsed.toLowerCase();
}

/**
 * Lines of program output: line endings unified, trailing whitespace ignored on every line, and
 * trailing blank lines dropped. Leading and inner whitespace stay significant.
 */
export function outputLines(value: string, caseSensitive: boolean): string[] {
  const lines = value
    .normalize("NFC")
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .map((line) => (caseSensitive ? line : line.toLowerCase()));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
