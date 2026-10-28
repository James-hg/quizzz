/** JSON shapes the browser receives from the app's own API (dates arrive as strings). */

export type AnchorView = {
  type: string;
  index?: number;
  page?: number;
  slide?: number;
  line?: number;
};

export type WarningView = { code: string; message: string; anchor?: AnchorView };

export type ImportOption = { id: string; text: string };

export type ImportQuestionPayload = {
  kind: "question";
  type: "mcq_single" | "mcq_multi";
  prompt: string;
  /** The prompt as written, set when a leading question number was removed. */
  originalPrompt?: string | null;
  /** The picture that came with the question. Its description may still be empty. */
  image?: { imageId: string; alt: string } | null;
  codeSnippet?: string | null;
  explanation?: string | null;
  options: ImportOption[];
  correctOptionIds: string[];
};

export type ImportItemView = {
  id: string;
  position: number;
  kind: "question" | "material";
  payload: ImportQuestionPayload | { kind: "material"; text: string };
  warnings: WarningView[];
  decision: "pending" | "accepted" | "edited" | "excluded";
  sources: { ordinal: number; kind: string; text: string }[];
};

export type ImportView = {
  id: string;
  courseId: string;
  status: "extracted" | "reviewing" | "published" | "failed";
  errorMessage: string | null;
  warnings: WarningView[];
  publishedQuestionSetId: string | null;
  source: { filename: string; sizeBytes: number } | null;
  items: ImportItemView[];
};

export type SupportedFormat = { extension: string; label: string };

export function describeAnchor(anchor?: AnchorView): string {
  if (!anchor) return "";
  if (anchor.type === "docx_paragraph" && anchor.index !== undefined)
    return `paragraph ${anchor.index + 1}`;
  if (anchor.type === "pdf_page" && anchor.page) return `page ${anchor.page}`;
  if (anchor.type === "slide" && anchor.slide) return `slide ${anchor.slide}`;
  if (anchor.type === "line" && anchor.line) return `line ${anchor.line}`;
  return "";
}

export type QuestionType =
  "mcq_single" | "mcq_multi" | "short_answer" | "fill_blank" | "output_prediction";

export type OwnerAnswerKey =
  | { kind: "options"; correctOptionIds: string[] }
  | { kind: "text"; accepted: string[]; caseSensitive: boolean }
  | { kind: "blanks"; blanks: string[][]; caseSensitive: boolean }
  | { kind: "unresolved" };

/** A question as its owner sees it in the editor (includes the answer key). */
export type OwnerQuestionView = {
  id: string;
  questionSetId: string;
  position: number;
  status: "active" | "excluded" | "reported";
  revisionId: string;
  revisionNumber: number;
  type: QuestionType;
  prompt: string;
  codeSnippet: string | null;
  options: ImportOption[];
  answerKey: OwnerAnswerKey;
  explanation: string | null;
  origin: string;
  evidenceStatus: string;
  image?: { id: string; url: string; alt: string } | null;
};

export type PlayOption = { id: string; text: string };

export type PlayQuestion = {
  questionId: string;
  revisionNumber: number;
  type: QuestionType;
  prompt: string;
  codeSnippet: string | null;
  /** The picture this question shows, if any. Only the owner of the question can load it. */
  image?: { id: string; url: string; alt: string } | null;
  options: PlayOption[];
  /** Only for fill-in questions: how many answers to collect. */
  blankCount?: number;
};

export type PlayResponse =
  | { kind: "options"; selectedOptionIds: string[] }
  | { kind: "text"; text: string }
  | { kind: "blanks"; values: string[] };

export type CorrectAnswer =
  | { kind: "options"; correctOptionIds: string[] }
  | { kind: "text"; accepted: string[] }
  | { kind: "blanks"; blanks: string[][] }
  | { kind: "unresolved" };

export type AnswerResult = {
  attemptId: string;
  outcome: "correct" | "incorrect" | "uncertain";
  isCorrect: boolean | null;
  response: PlayResponse;
  correctAnswer: CorrectAnswer;
  explanation: string | null;
  submittedAt: string;
};

export type PlayItem =
  | { questionId: string; position: number; status: "pending" | "removed" }
  | { questionId: string; position: number; status: "answered"; result: AnswerResult };

export type PlaySession = {
  id: string;
  questionSetId: string;
  courseId: string;
  mode: string;
  state: "active" | "paused" | "completed" | "abandoned";
  startedAt: string;
  completedAt: string | null;
  elapsedSeconds: number;
  currentIndex: number;
  progress: { total: number; answered: number; removed: number };
  items: PlayItem[];
  current: PlayQuestion | null;
};

export type SessionSummary = {
  totalItems: number;
  answered: number;
  correct: number;
  incorrect: number;
  uncertain: number;
  unanswered: number;
  elapsedSeconds: number;
};
