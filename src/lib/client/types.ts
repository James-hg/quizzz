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
  /** 2 when this is the retry of a question answered wrongly earlier. */
  pass?: 1 | 2;
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

/** How much of a result the server revealed: everything, only right/wrong, or nothing yet. */
export type Disclosure = "full" | "verdict" | "none";

export type RevealMode = "each" | "end" | "requeue";

export type AnswerResult = {
  attemptId: string;
  /** 1 for the first answer, 2 for the single retry of a wrong answer (requeue mode). */
  pass: 1 | 2;
  disclosure: Disclosure;
  response: PlayResponse;
  submittedAt: string;
  /** Present for `verdict` and `full`. */
  outcome?: "correct" | "incorrect" | "uncertain";
  isCorrect?: boolean | null;
  /** Present only for `full`. */
  correctAnswer?: CorrectAnswer;
  explanation?: string | null;
};

export type PlayItem =
  | { questionId: string; position: number; pass: 1 | 2; status: "pending" | "removed" }
  | {
      questionId: string;
      position: number;
      pass: 1 | 2;
      status: "answered";
      result: AnswerResult;
      /** Present once the session has ended, so the results can be reviewed. */
      question?: PlayQuestion;
    };

export type PlaySession = {
  id: string;
  questionSetId: string;
  courseId: string;
  mode: string;
  revealMode: RevealMode;
  state: "active" | "paused" | "completed" | "abandoned";
  startedAt: string;
  completedAt: string | null;
  elapsedSeconds: number;
  currentIndex: number;
  progress: { total: number; answered: number; removed: number; retries: number };
  items: PlayItem[];
  current: PlayQuestion | null;
};

export type SessionSummary = {
  /** Questions in the session, counted once. The counts below are first tries only. */
  totalItems: number;
  answered: number;
  correct: number;
  incorrect: number;
  uncertain: number;
  unanswered: number;
  /** Second tries of wrong answers (requeue mode). */
  retry: { total: number; answered: number; correct: number; incorrect: number; uncertain: number };
  revealMode: RevealMode;
  elapsedSeconds: number;
};

/** A rewrite of a question, as the editor shows it (the same shape for a fresh and a saved one). */
export type RewriteContent = {
  type: QuestionType;
  prompt: string;
  codeSnippet?: string | null;
  explanation?: string | null;
  options?: ImportOption[];
  correctOptionIds?: string[];
  accepted?: string[];
  blanks?: string[][];
};

export type RewriteProposalView = {
  mode: "rephrase" | "vary_numbers" | "add_explanation";
  baseRevisionId: string;
  content: RewriteContent;
  origin: string;
  evidenceStatus: string;
  warnings: string[];
};

export type SavedRewriteView = {
  id: string;
  questionId: string;
  mode: RewriteProposalView["mode"];
  content: RewriteContent;
  origin: string;
  evidenceStatus: string;
  stale: boolean;
  createdAt: string;
};
