import type {
  AnswerResult,
  PlayQuestion,
  PlayResponse,
  PlaySession,
  SessionSummary,
} from "@/lib/client/types";

/** Where the student is in answering the current question. */
export type Phase = "answering" | "submitting" | "feedback";

export type PlayState = {
  session: PlaySession;
  phase: Phase;
  /** Selected option ids (multiple choice), the text answer, or one value per blank. */
  selected: string[];
  text: string;
  blanks: string[];
  /** Fixed for one question so a retry after a network failure cannot create a second attempt. */
  idempotencyKey: string | null;
  feedback: AnswerResult | null;
  summary: SessionSummary | null;
  error: string | null;
  /** True while a pause/resume/complete/next request is in flight. */
  busy: boolean;
};

export type PlayAction =
  | { type: "select"; optionId: string; multiple: boolean }
  | { type: "text"; value: string }
  | { type: "blank"; index: number; value: string }
  | { type: "submit_start"; key: string }
  | { type: "submit_ok"; result: AnswerResult }
  | { type: "submit_fail"; error: string }
  | { type: "busy" }
  | { type: "session"; session: PlaySession }
  | { type: "complete_ok"; session: PlaySession; summary: SessionSummary }
  | { type: "fail"; error: string };

function blankCount(question: PlayQuestion | null): number {
  return question?.type === "fill_blank" ? (question.blankCount ?? 1) : 0;
}

/** Resets everything tied to one question while keeping the session. */
function forQuestion(
  session: PlaySession,
): Pick<PlayState, "phase" | "selected" | "text" | "blanks" | "idempotencyKey" | "feedback"> {
  return {
    phase: "answering",
    selected: [],
    text: "",
    blanks: Array.from({ length: blankCount(session.current) }, () => ""),
    idempotencyKey: null,
    feedback: null,
  };
}

export function initialState(session: PlaySession): PlayState {
  return {
    session,
    ...forQuestion(session),
    summary: session.state === "completed" ? summarize(session) : null,
    error: null,
    busy: false,
  };
}

/** Counts from the results the server already returned for answered items. */
export function summarize(session: PlaySession): SessionSummary {
  const results = session.items.flatMap((i) => (i.status === "answered" ? [i.result] : []));
  const removed = session.items.filter((i) => i.status === "removed").length;
  return {
    totalItems: session.progress.total,
    answered: results.length,
    correct: results.filter((r) => r.outcome === "correct").length,
    incorrect: results.filter((r) => r.outcome === "incorrect").length,
    uncertain: results.filter((r) => r.outcome === "uncertain").length,
    unanswered: session.progress.total - removed - results.length,
    elapsedSeconds: session.elapsedSeconds,
  };
}

export function playReducer(state: PlayState, action: PlayAction): PlayState {
  switch (action.type) {
    case "select": {
      if (state.phase !== "answering") return state;
      const selected = action.multiple
        ? state.selected.includes(action.optionId)
          ? state.selected.filter((id) => id !== action.optionId)
          : [...state.selected, action.optionId]
        : [action.optionId];
      return { ...state, selected, error: null };
    }
    case "text":
      return state.phase === "answering" ? { ...state, text: action.value, error: null } : state;
    case "blank":
      return state.phase === "answering"
        ? {
            ...state,
            blanks: state.blanks.map((b, i) => (i === action.index ? action.value : b)),
            error: null,
          }
        : state;
    case "submit_start":
      if (state.phase !== "answering") return state;
      return {
        ...state,
        phase: "submitting",
        idempotencyKey: state.idempotencyKey ?? action.key,
        error: null,
      };
    case "submit_ok": {
      if (state.phase !== "submitting") return state;
      const answered = state.session.progress.answered + (isNewAnswer(state) ? 1 : 0);
      return {
        ...state,
        phase: "feedback",
        feedback: action.result,
        session: {
          ...state.session,
          progress: { ...state.session.progress, answered },
        },
      };
    }
    case "submit_fail":
      // Back to answering with the same idempotency key, so retrying is safe.
      return state.phase === "submitting"
        ? { ...state, phase: "answering", error: action.error }
        : state;
    case "busy":
      return { ...state, busy: true, error: null };
    case "session":
      return {
        ...state,
        ...forQuestion(action.session),
        session: action.session,
        busy: false,
        error: null,
      };
    case "complete_ok":
      return {
        ...state,
        ...forQuestion(action.session),
        session: action.session,
        summary: action.summary,
        busy: false,
        error: null,
      };
    case "fail":
      return { ...state, busy: false, error: action.error };
  }
}

/** The current question is not yet counted as answered in `progress` until feedback arrives. */
function isNewAnswer(state: PlayState): boolean {
  const current = state.session.current;
  if (!current) return false;
  const item = state.session.items.find((i) => i.questionId === current.questionId);
  return item?.status === "pending";
}

/** What to send for the current question, or null while the answer is still incomplete. */
export function currentResponse(state: PlayState): PlayResponse | null {
  const q = state.session.current;
  if (!q) return null;
  if (q.type === "mcq_single" || q.type === "mcq_multi") {
    return state.selected.length > 0
      ? { kind: "options", selectedOptionIds: state.selected }
      : null;
  }
  if (q.type === "fill_blank") {
    return state.blanks.length > 0 && state.blanks.every((b) => b.trim() !== "")
      ? { kind: "blanks", values: state.blanks }
      : null;
  }
  return state.text.trim() !== "" ? { kind: "text", text: state.text } : null;
}
