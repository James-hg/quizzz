import type { Metadata } from "next";
import Link from "next/link";
import { QuestionEditor } from "@/components/editor/QuestionEditor";
import { RenameSetForm } from "@/components/RenameSetForm";
import { StartPracticeButton } from "@/components/StartPracticeButton";
import type { OwnerQuestionView } from "@/lib/client/types";
import { formatDate } from "@/lib/labels";
import { idParam, orNotFound, requirePageUser } from "@/server/auth/page";
import { getCourse } from "@/server/content/courses";
import { getQuestionSet } from "@/server/content/question-sets";
import { listQuestions } from "@/server/content/questions";
import { getDb } from "@/server/db";
import { listSetHistory } from "@/server/sessions/history";

export const metadata: Metadata = { title: "Edit questions · Quizzz" };
export const dynamic = "force-dynamic";

export default async function EditSetPage({ params }: { params: Promise<{ setId: string }> }) {
  const user = await requirePageUser();
  const db = getDb();
  const setId = await idParam(params, "setId");
  const set = await orNotFound(getQuestionSet(db, user.id, setId));
  const [course, questions, history] = await Promise.all([
    getCourse(db, user.id, set.courseId),
    listQuestions(db, user.id, setId),
    listSetHistory(db, user.id, setId),
  ]);
  // Dates become strings across the server/client boundary.
  const initial = JSON.parse(JSON.stringify(questions)) as OwnerQuestionView[];
  const playable = questions.filter((q) => q.status === "active").length;

  return (
    <div className="stack">
      <p className="crumbs">
        <Link href="/">Home</Link> / <Link href={`/courses/${course.id}`}>{course.title}</Link> /{" "}
        {set.title}
      </p>
      <div className="page-head">
        <div>
          <h1>{set.title}</h1>
          <p className="muted">
            {questions.length} {questions.length === 1 ? "question" : "questions"}
            {playable !== questions.length ? ` · ${questions.length - playable} excluded` : ""}
          </p>
        </div>
        <StartPracticeButton
          questionSetId={set.id}
          disabled={playable === 0}
          label="Practice this set"
        />
      </div>

      <QuestionEditor questionSetId={set.id} questions={initial} />

      {history.length > 0 ? (
        <section className="card" aria-labelledby="history-heading">
          <h2 id="history-heading">Past sessions</h2>
          <ul className="list">
            {history.map((h) => (
              <li key={h.sessionId} className="row row-between">
                <span>{formatDate(h.completedAt)}</span>
                <span>
                  {h.correct} correct of {h.answered} answered
                  <span className="muted small"> ({h.totalItems} questions)</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className="card">
        <summary>Set settings</summary>
        <div style={{ marginTop: "1rem" }}>
          <RenameSetForm setId={set.id} title={set.title} courseId={course.id} />
        </div>
      </details>
    </div>
  );
}
