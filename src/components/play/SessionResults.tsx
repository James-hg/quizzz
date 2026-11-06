"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch, errorMessage } from "@/lib/client/api";
import type { SessionResults as Results } from "@/lib/client/types";
import { formatDate } from "@/lib/labels";
import { Alert } from "../ui/Alert";

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The headline, in words that match what the server counted. */
function headline(r: Results): string {
  const f = r.firstPass;
  if (f.answered === 0) return "No questions were answered in this session";
  const right = f.independentCorrect + f.assistedCorrect;
  return `${right} correct out of ${f.answered} answered${r.retry.total > 0 ? " on the first try" : ""}`;
}

/**
 * The finished-session report, read from the server's own records once the session has ended.
 * Whether an answer counts as assisted is decided from the help recorded before it was
 * submitted, never from anything the page remembers. If the report cannot be loaded, nothing is
 * filled in from smaller summaries.
 */
export function SessionResults({
  sessionId,
  questionSetId,
  courseId,
}: {
  sessionId: string;
  questionSetId: string | null;
  courseId: string;
}) {
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Results>(`/api/sessions/${sessionId}/results`)
      .then((data) => {
        if (!cancelled) setResults(data);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, attempt]);

  function retry() {
    setError(null);
    setResults(null);
    setAttempt((n) => n + 1);
  }

  if (error) {
    return (
      <div className="card stack-sm">
        <Alert tone="error">{error}</Alert>
        <div>
          <button type="button" className="btn" onClick={retry}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!results) {
    return (
      <div className="card" aria-live="polite">
        <p className="muted">Loading your results…</p>
      </div>
    );
  }

  const r = results;
  const f = r.firstPass;
  const endedEarly = r.state === "abandoned";
  const exam = r.mode === "exam";
  return (
    <div className="card stack-sm" aria-live="polite">
      {exam ? <p className="badge">Exam practice, not a grade</p> : null}
      {endedEarly ? <p className="badge badge-warn">Ended early</p> : null}
      <p className="question-prompt">{headline(r)}</p>
      <ul className="list">
        <li>
          Right on your own: {f.independentCorrect}
          {f.assistedCorrect > 0 ? ` · right with help: ${f.assistedCorrect}` : ""}
        </li>
        <li>
          Questions: {r.uniqueQuestions} answered · answers recorded: {r.attempts}
        </li>
        {f.incorrect > 0 ? <li>Not right: {f.incorrect}</li> : null}
        {f.unanswered > 0 ? <li>Not answered: {f.unanswered}</li> : null}
        {f.uncertain > 0 ? <li>Could not be checked automatically: {f.uncertain}</li> : null}
        {r.retry.total > 0 ? (
          <li>
            Second tries: {r.retry.correct} correct out of {r.retry.answered}
            {r.retry.total > r.retry.answered
              ? ` (${r.retry.total - r.retry.answered} not tried)`
              : ""}
          </li>
        ) : null}
        {r.generatedQuestions > 0 ? (
          <li>
            From your questions: {r.originalQuestions} · AI-generated: {r.generatedQuestions}
          </li>
        ) : null}
        <li>
          Time: {formatClock(r.elapsedSeconds)}
          {r.timeBudgetMinutes ? ` of ${r.timeBudgetMinutes} minutes planned` : ""}
        </li>
      </ul>
      {f.assistedCorrect > 0 ? (
        <p className="hint">
          Answers that came after help are counted separately. They help you learn, and they are
          different evidence from answering on your own.
        </p>
      ) : null}

      {r.questionSetsNeedingPractice.length > 0 ? (
        <div>
          <h2 className="small">Question sets needing practice</h2>
          <ul className="list">
            {r.questionSetsNeedingPractice.map((s) => (
              <li key={s.questionSetId} className="row row-between">
                <Link href={`/question-sets/${s.questionSetId}/edit`}>{s.title}</Link>
                <span className="small muted">
                  {[
                    s.missed > 0 ? `${plural(s.missed, "miss", "misses")}` : null,
                    s.assisted > 0 ? `${s.assisted} with help` : null,
                    s.unchecked > 0 ? `${s.unchecked} unchecked` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="small">
        {r.nextReviewAt
          ? `Next planned review: ${formatDate(r.nextReviewAt)}.`
          : "No review is planned yet."}
      </p>
      <div className="row">
        <Link className="btn btn-primary" href="/">
          Back to home
        </Link>
        <Link
          className="btn"
          href={questionSetId ? `/question-sets/${questionSetId}/edit` : `/courses/${courseId}`}
        >
          {questionSetId ? "Back to the question set" : "Back to the course"}
        </Link>
      </div>
    </div>
  );
}
