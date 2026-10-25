"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/client/api";
import { LANGUAGE_LABELS } from "@/lib/labels";
import { Alert } from "./ui/Alert";

export type SampleSummary = {
  language: string;
  title: string;
  subject: string;
  questionCount: number;
  checkedQuestionCount: number;
};

type Props = {
  samples: SampleSummary[];
  /** Samples this user already copied, by language. */
  loaded: Record<string, { courseId: string }>;
};

/**
 * Lets a student copy a ready-made course into their account. Hidden when there are none.
 * The copy says plainly when a sample has not been checked, because its questions then need
 * the student's review before they can be practised.
 */
export function SampleCourses({ samples, loaded }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (samples.length === 0) return null;

  async function load(language: string) {
    setError(null);
    setBusy(language);
    try {
      const result = await apiFetch<{ courseId: string }>(`/api/samples/${language}/load`, {
        method: "POST",
      });
      router.push(`/courses/${result.courseId}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  const anyUnchecked = samples.some((s) => s.checkedQuestionCount < s.questionCount);

  return (
    <section aria-labelledby="samples-heading" className="card">
      <h2 id="samples-heading">Explore a sample course</h2>
      <p className="muted small">
        Try Quizzz with a ready-made course. You get your own copy to edit or delete.
        {anyUnchecked
          ? " Sample content is a draft and has not been checked: its questions need your review before you can practise them."
          : ""}
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <ul className="list">
        {samples.map((sample) => {
          const copy = loaded[sample.language];
          const unchecked = sample.questionCount - sample.checkedQuestionCount;
          return (
            <li key={sample.language} className="row row-between">
              <span>
                <strong>{sample.title}</strong>
                <br />
                <span className="small muted">{sample.subject}</span>
                <br />
                <span className="row small">
                  <span className="badge">
                    {LANGUAGE_LABELS[sample.language] ?? sample.language}
                  </span>
                  <span className="muted">
                    {sample.questionCount} {sample.questionCount === 1 ? "question" : "questions"}
                  </span>
                  {unchecked > 0 ? (
                    <span className="badge badge-warn">
                      {unchecked === sample.questionCount
                        ? "Draft, not checked"
                        : `${unchecked} not checked`}
                    </span>
                  ) : null}
                </span>
              </span>
              {copy ? (
                <Link className="btn" href={`/courses/${copy.courseId}`}>
                  Open your copy
                </Link>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => load(sample.language)}
                  disabled={busy !== null}
                  aria-label={`Add ${sample.title} to my courses`}
                >
                  {busy === sample.language ? "Adding…" : "Add to my courses"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
