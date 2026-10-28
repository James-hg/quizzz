"use client";

import Link from "next/link";
import { useEffect, useReducer, useRef, useState } from "react";
import { ApiClientError, apiFetch, errorMessage } from "@/lib/client/api";
import type { AnswerResult, CorrectAnswer, PlaySession, SessionSummary } from "@/lib/client/types";
import { Alert } from "../ui/Alert";
import { ConfirmButton } from "../ConfirmButton";
import { StartPracticeButton } from "../StartPracticeButton";
import { currentResponse, initialState, playReducer } from "./state";

type Props = { initial: PlaySession; setTitle: string };

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Counts up from the server's elapsed time; remounted (via key) whenever the server value changes. */
function Clock({ seconds, running }: { seconds: number; running: boolean }) {
  const [extra, setExtra] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setExtra((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  return (
    <span className="badge" role="timer" aria-label="Time spent">
      {formatClock(seconds + extra)}
    </span>
  );
}

function Outcome({ result }: { result: AnswerResult }) {
  const text =
    result.outcome === "correct"
      ? "Correct"
      : result.outcome === "incorrect"
        ? "Not quite"
        : "This answer can’t be checked automatically";
  return (
    <strong>
      {result.outcome === "correct" ? "✓ " : result.outcome === "incorrect" ? "✗ " : "? "}
      {text}
    </strong>
  );
}

function CorrectAnswerView({ answer }: { answer: CorrectAnswer }) {
  if (answer.kind === "unresolved") {
    return <p className="small">No correct answer has been set for this question yet.</p>;
  }
  if (answer.kind === "text") {
    return (
      <p className="small">
        <strong>Accepted answer{answer.accepted.length > 1 ? "s" : ""}:</strong>{" "}
        <span className="mono" style={{ whiteSpace: "pre-wrap" }}>
          {answer.accepted.join("  ·  ")}
        </span>
      </p>
    );
  }
  if (answer.kind === "blanks") {
    return (
      <ol className="small">
        {answer.blanks.map((alts, i) => (
          <li key={i}>{alts.join(" or ")}</li>
        ))}
      </ol>
    );
  }
  return null;
}

export function PlayScreen({ initial, setTitle }: Props) {
  const [state, dispatch] = useReducer(playReducer, initial, initialState);
  const { session, phase } = state;
  const question = session.current;
  const feedbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (phase === "feedback") feedbackRef.current?.focus();
  }, [phase]);

  async function submit() {
    const response = currentResponse(state);
    if (!question || !response) return;
    // One key per question: a retry after a failed request reuses it, so it can never double-submit.
    const key = state.idempotencyKey ?? crypto.randomUUID();
    dispatch({ type: "submit_start", key });
    try {
      const { result } = await apiFetch<{ result: AnswerResult }>(
        `/api/sessions/${session.id}/answers`,
        {
          body: { questionId: question.questionId, response, idempotencyKey: key },
        },
      );
      dispatch({ type: "submit_ok", result });
    } catch (e) {
      dispatch({ type: "submit_fail", error: errorMessage(e) });
      // The question was already answered (e.g. in another tab): show the current server state.
      if (e instanceof ApiClientError && e.code === "already_answered") void refresh();
    }
  }

  async function refresh() {
    dispatch({ type: "busy" });
    try {
      const { session: next } = await apiFetch<{ session: PlaySession }>(
        `/api/sessions/${session.id}`,
      );
      dispatch({ type: "session", session: next });
    } catch (e) {
      dispatch({ type: "fail", error: errorMessage(e) });
    }
  }

  async function patch(action: "pause" | "resume") {
    dispatch({ type: "busy" });
    try {
      const { session: next } = await apiFetch<{ session: PlaySession }>(
        `/api/sessions/${session.id}`,
        {
          method: "PATCH",
          body: { action },
        },
      );
      dispatch({ type: "session", session: next });
    } catch (e) {
      dispatch({ type: "fail", error: errorMessage(e) });
    }
  }

  async function finish() {
    dispatch({ type: "busy" });
    try {
      const done = await apiFetch<{ session: PlaySession; summary: SessionSummary }>(
        `/api/sessions/${session.id}/complete`,
        { method: "POST" },
      );
      dispatch({ type: "complete_ok", session: done.session, summary: done.summary });
    } catch (e) {
      dispatch({ type: "fail", error: errorMessage(e) });
    }
  }

  const { total, answered, removed } = session.progress;
  const percent = total - removed > 0 ? Math.round((answered / (total - removed)) * 100) : 0;
  const running = session.state === "active";
  const response = currentResponse(state);

  if (state.summary) {
    const s = state.summary;
    return (
      <div className="stack page-narrow">
        <h1>Session complete</h1>
        <div className="card" aria-live="polite">
          <p className="question-prompt">
            {s.correct} correct out of {s.answered} answered
          </p>
          <ul className="list">
            <li>Questions in this session: {s.totalItems}</li>
            <li>Not answered: {s.unanswered}</li>
            {s.uncertain > 0 ? <li>Could not be checked automatically: {s.uncertain}</li> : null}
            <li>Time: {formatClock(s.elapsedSeconds)}</li>
          </ul>
          <div className="row">
            <StartPracticeButton questionSetId={session.questionSetId} label="Practise again" />
            <Link className="btn" href={`/question-sets/${session.questionSetId}/edit`}>
              Back to the question set
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack page-narrow">
      <div className="page-head">
        <div>
          <p className="crumbs">
            <Link href={`/question-sets/${session.questionSetId}/edit`}>{setTitle}</Link>
          </p>
          <h1>Practice</h1>
        </div>
        <div className="row">
          <Clock
            key={`${session.elapsedSeconds}-${session.state}`}
            seconds={session.elapsedSeconds}
            running={running}
          />
          {running ? (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => patch("pause")}
              disabled={state.busy || phase === "submitting"}
            >
              Pause
            </button>
          ) : null}
          <ConfirmButton
            label="End session"
            confirmLabel="Yes, end it"
            className="btn btn-small"
            disabled={state.busy || phase === "submitting"}
            onConfirm={finish}
          />
        </div>
      </div>

      <div
        className="progress"
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${answered} of ${total - removed} answered`}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <p className="small muted">
        {answered} of {total - removed} answered
      </p>

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {removed > 0 ? (
        <Alert tone="warning">
          {removed} {removed === 1 ? "question was" : "questions were"} removed from this set and
          skipped.
        </Alert>
      ) : null}

      {session.state === "paused" ? (
        <div className="card">
          <h2>Paused</h2>
          <p className="muted">The timer is stopped. Your answers so far are saved.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => patch("resume")}
            disabled={state.busy}
          >
            Resume
          </button>
        </div>
      ) : !question ? (
        <div className="card">
          <h2>That was the last question</h2>
          <p className="muted">Finish to see how you did.</p>
          <button type="button" className="btn btn-primary" onClick={finish} disabled={state.busy}>
            Finish session
          </button>
        </div>
      ) : (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            if (phase === "answering") void submit();
          }}
        >
          <fieldset style={{ border: 0, padding: 0 }} disabled={phase !== "answering"}>
            <legend className="question-prompt">{question.prompt}</legend>
            {question.image ? (
              // eslint-disable-next-line @next/next/no-img-element -- an authenticated API route, not a static asset
              <img className="question-image" src={question.image.url} alt={question.image.alt} />
            ) : null}
            {question.codeSnippet ? <pre className="code">{question.codeSnippet}</pre> : null}

            {question.type === "mcq_single" || question.type === "mcq_multi" ? (
              <ul className="options">
                {question.options.map((o) => {
                  const multiple = question.type === "mcq_multi";
                  const feedback = phase === "feedback" ? state.feedback : null;
                  const isCorrect =
                    feedback?.correctAnswer.kind === "options" &&
                    feedback.correctAnswer.correctOptionIds.includes(o.id);
                  const chosenWrong =
                    feedback &&
                    state.selected.includes(o.id) &&
                    !isCorrect &&
                    feedback.outcome === "incorrect";
                  return (
                    <li key={o.id}>
                      <label
                        className={`option ${isCorrect ? "option-correct" : ""} ${chosenWrong ? "option-wrong" : ""}`}
                      >
                        <input
                          type={multiple ? "checkbox" : "radio"}
                          name={`q-${question.questionId}`}
                          checked={state.selected.includes(o.id)}
                          onChange={() => dispatch({ type: "select", optionId: o.id, multiple })}
                        />
                        <span>
                          {o.text}
                          {isCorrect ? <strong> — correct answer</strong> : null}
                          {chosenWrong ? <strong> — your answer</strong> : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : question.type === "fill_blank" ? (
              <div className="stack-sm">
                {state.blanks.map((value, i) => (
                  <div className="field" key={i}>
                    <label htmlFor={`blank-${i}`}>Blank {i + 1}</label>
                    <input
                      id={`blank-${i}`}
                      type="text"
                      value={value}
                      autoComplete="off"
                      onChange={(e) => dispatch({ type: "blank", index: i, value: e.target.value })}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="field">
                <label htmlFor="answer-text">
                  {question.type === "output_prediction" ? "What does it print?" : "Your answer"}
                </label>
                <textarea
                  id="answer-text"
                  className={question.type === "output_prediction" ? "mono" : undefined}
                  value={state.text}
                  spellCheck={false}
                  onChange={(e) => dispatch({ type: "text", value: e.target.value })}
                />
              </div>
            )}
          </fieldset>

          {phase === "feedback" && state.feedback ? (
            <div
              ref={feedbackRef}
              tabIndex={-1}
              aria-live="polite"
              className={`result result-${state.feedback.outcome}`}
            >
              <p>
                <Outcome result={state.feedback} />
              </p>
              <CorrectAnswerView answer={state.feedback.correctAnswer} />
              {state.feedback.explanation ? (
                <p className="small">{state.feedback.explanation}</p>
              ) : null}
            </div>
          ) : null}

          <div className="row" style={{ marginTop: "1rem" }}>
            {phase === "feedback" ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={refresh}
                disabled={state.busy}
              >
                Next
              </button>
            ) : (
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!response || phase === "submitting"}
              >
                {phase === "submitting" ? "Checking…" : "Submit answer"}
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
