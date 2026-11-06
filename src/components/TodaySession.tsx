"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { ApiClientError, apiFetch, errorMessage } from "@/lib/client/api";
import type { TodayPlan } from "@/lib/client/types";
import { Alert } from "./ui/Alert";

type Course = { id: string; title: string };
type Mode = "review" | "exam";

const LIMITED: Record<string, string> = {
  budget: "More is due than fits, so the rest waits for another day.",
  content: "That is everything available in this course right now.",
};

/**
 * One calm place to start: the course, why this session, how long it takes, and a single main
 * button. Everything here is a preview from the server; nothing is planned until you start.
 */
export function TodaySession({ courses }: { courses: Course[] }) {
  const router = useRouter();
  const courseSelect = useId();
  const [courseId, setCourseId] = useState(courses[0]?.id ?? "");
  const [plan, setPlan] = useState<TodayPlan | null>(null);
  const [budget, setBudget] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<Mode | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;
    apiFetch<TodayPlan>(`/api/today?courseId=${courseId}`)
      .then((data) => {
        if (cancelled) return;
        setPlan(data);
        setBudget(data.recommendedBudgetMinutes);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, attempt]);

  function chooseCourse(id: string) {
    setCourseId(id);
    setPlan(null);
    setBudget(null);
    setError(null);
  }

  function retry() {
    setError(null);
    setAttempt((n) => n + 1);
  }

  async function start(mode: Mode) {
    if (!plan || budget === null) return;
    setStarting(mode);
    setError(null);
    try {
      const { session } = await apiFetch<{ session: { id: string } }>("/api/sessions", {
        body: { courseId, mode, timeBudgetMinutes: budget },
      });
      router.push(`/sessions/${session.id}`);
    } catch (e) {
      setError(
        e instanceof ApiClientError && e.code === "no_playable_questions"
          ? "There are no questions to practise in this course yet. Add or approve some first."
          : errorMessage(e),
      );
      setStarting(null);
    }
  }

  if (courses.length === 0) return null;

  const chosen = plan?.options.find((o) => o.minutes === budget);
  const isRecommended = plan !== null && budget === plan.recommendedBudgetMinutes;
  const nothing = plan !== null && plan.availableCount === 0;
  const live = plan?.liveSessionId;

  return (
    <section className="card stack-sm" aria-labelledby="today-heading">
      <h2 id="today-heading">Today</h2>

      {courses.length > 1 ? (
        <div className="field">
          <label htmlFor={courseSelect}>Course</label>
          <select
            id={courseSelect}
            value={courseId}
            onChange={(e) => chooseCourse(e.target.value)}
            disabled={starting !== null}
          >
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="muted">{courses[0]!.title}</p>
      )}

      {error ? (
        <div className="stack-sm">
          <Alert tone="error">{error}</Alert>
          {!plan ? (
            <div>
              <button type="button" className="btn btn-small" onClick={retry}>
                Try again
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {!plan && !error ? (
        <p className="muted" aria-live="polite">
          Working out today’s session…
        </p>
      ) : null}

      {plan && nothing ? (
        <p>
          Nothing is ready to practise in this course yet. Import a document or approve some
          questions first. <Link href={`/courses/${plan.course.id}`}>Open the course</Link>
        </p>
      ) : null}

      {plan && !nothing ? (
        <>
          {live ? (
            <p>
              You already have a session going for this course. Its length was fixed when it
              started.
            </p>
          ) : (
            <>
              <fieldset className="today-budgets">
                <legend className="small">How long do you have?</legend>
                {plan.budgetOptions.map((minutes) => (
                  <label key={minutes} className="row">
                    <input
                      type="radio"
                      name="budget"
                      checked={budget === minutes}
                      onChange={() => setBudget(minutes)}
                      disabled={starting !== null}
                    />
                    {minutes} min
                    {minutes === plan.recommendedBudgetMinutes ? (
                      <span className="badge">Suggested</span>
                    ) : null}
                  </label>
                ))}
              </fieldset>
              <div aria-live="polite" className="stack-sm">
                {chosen ? (
                  <p>
                    <strong>{chosen.questionCount}</strong>{" "}
                    {chosen.questionCount === 1 ? "question" : "questions"} fit in {budget} minutes
                    {isRecommended && plan.estimatedDurationMinutes > 0
                      ? `, about ${plan.estimatedDurationMinutes} ${plan.estimatedDurationMinutes === 1 ? "minute" : "minutes"}`
                      : ""}
                    .
                  </p>
                ) : null}
                {isRecommended ? (
                  <ul className="list small">
                    {plan.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="small muted">
                    The 5, 10 and 20 minute plans each hold a different number of questions. The
                    reasons are for the suggested length.
                  </p>
                )}
                {chosen?.limitedBy ? (
                  <p className="small muted">{LIMITED[chosen.limitedBy]}</p>
                ) : null}
                <p className="small muted">
                  The length is a plan, not a timer: no question is cut off halfway.
                </p>
              </div>
            </>
          )}

          <div className="row">
            {live ? (
              <Link className="btn btn-primary" href={`/sessions/${live}`}>
                Resume today’s session
              </Link>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={starting !== null || budget === null}
                onClick={() => void start("review")}
              >
                {starting === "review" ? "Starting…" : "Start today’s session"}
              </button>
            )}
          </div>

          <div className="stack-sm">
            <p className="small muted">Other ways to practise</p>
            <ul className="list">
              <li className="row">
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={starting !== null || budget === null || Boolean(live)}
                  onClick={() => void start("exam")}
                >
                  {starting === "exam" ? "Starting…" : "Exam practice"}
                </button>
                <span className="small muted">
                  Practice under exam conditions: no help, and your results come at the end.
                </span>
              </li>
              <li className="row">
                <button
                  type="button"
                  className="btn btn-small"
                  disabled
                  aria-describedby="learn-why"
                >
                  Learn a topic
                </button>
                <span id="learn-why" className="small muted">
                  Not available yet. Guided topic learning is planned for a later phase.
                </span>
              </li>
              <li className="row">
                <button
                  type="button"
                  className="btn btn-small"
                  disabled
                  aria-describedby="mixed-why"
                >
                  Mixed practice
                </button>
                <span id="mixed-why" className="small muted">
                  Not available yet. Mixed problem types are planned for a later phase.
                </span>
              </li>
            </ul>
          </div>
        </>
      ) : null}
    </section>
  );
}
