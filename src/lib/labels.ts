export const LANGUAGE_LABELS: Record<string, string> = {
  python: "Python",
  java: "Java",
  c: "C",
  cpp: "C++",
  javascript: "JavaScript",
};

export const LANGUAGES = Object.entries(LANGUAGE_LABELS).map(([value, label]) => ({
  value,
  label,
}));

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date =
    typeof value === "string" ? new Date(value.length === 10 ? `${value}T00:00:00` : value) : value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
