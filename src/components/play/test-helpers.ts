import type { AnswerResult, PlaySession } from "@/lib/client/types";

/** Builders for play-screen tests. */
export const result = (outcome: AnswerResult["outcome"]): AnswerResult => ({
  attemptId: "a",
  pass: 1,
  disclosure: "full",
  outcome,
  isCorrect: outcome === "uncertain" ? null : outcome === "correct",
  response: { kind: "options", selectedOptionIds: ["a"] },
  correctAnswer: { kind: "options", correctOptionIds: ["b"] },
  explanation: null,
  submittedAt: "2026-01-01T00:00:00Z",
});

export const session = (overrides: Partial<PlaySession> = {}): PlaySession => ({
  id: "s1",
  questionSetId: "set1",
  courseId: "c1",
  mode: "quiz",
  state: "active",
  startedAt: "2026-01-01T00:00:00Z",
  completedAt: null,
  elapsedSeconds: 0,
  currentIndex: 0,
  revealMode: "each",
  progress: { total: 2, answered: 0, removed: 0, retries: 0 },
  items: [
    { questionId: "q1", position: 0, pass: 1, status: "pending" },
    { questionId: "q2", position: 1, pass: 1, status: "pending" },
  ],
  current: {
    questionId: "q1",
    revisionNumber: 1,
    type: "mcq_single",
    prompt: "Pick b",
    codeSnippet: null,
    options: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ],
  },
  ...overrides,
});
