import type { AnswerResult, PlaySession, SessionResults } from "@/lib/client/types";

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
  timeBudgetMinutes: null,
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

/** The finished-session report as the server returns it. */
export const results = (overrides: Partial<SessionResults> = {}): SessionResults => ({
  sessionId: "s1",
  mode: "quiz",
  revealMode: "each",
  state: "completed",
  timeBudgetMinutes: null,
  elapsedSeconds: 65,
  uniqueQuestions: 1,
  attempts: 1,
  firstPass: {
    answered: 1,
    independentCorrect: 1,
    assistedCorrect: 0,
    incorrect: 0,
    uncertain: 0,
    unanswered: 1,
  },
  retry: { total: 0, answered: 0, correct: 0, incorrect: 0, uncertain: 0 },
  originalQuestions: 1,
  generatedQuestions: 0,
  questionSetsNeedingPractice: [],
  nextReviewAt: null,
  ...overrides,
});
