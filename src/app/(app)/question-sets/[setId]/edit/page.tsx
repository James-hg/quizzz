import type { Metadata } from "next";
import Link from "next/link";
import { QuestionEditor } from "@/components/editor/QuestionEditor";
import { AssistantPanel } from "@/components/AssistantPanel";
import { PracticeBlockedNotice } from "@/components/PracticeBlockedNotice";
import { RenameSetForm } from "@/components/RenameSetForm";
import { StartPracticeButton } from "@/components/StartPracticeButton";
import type { OwnerQuestionView } from "@/lib/client/types";
import { formatDate } from "@/lib/labels";
import { countPlayability, parseFilter } from "@/lib/playability";
import { idParam, orNotFound, requirePageUser } from "@/server/auth/page";
import { getCourse } from "@/server/content/courses";
import { getQuestionSet } from "@/server/content/question-sets";
import { listQuestions } from "@/server/content/questions";
import { listPendingRewritesForSet } from "@/server/content/rewrites";
import { getDb } from "@/server/db";
import { getEnv } from "@/server/env";
import { listSetHistory } from "@/server/sessions/history";

export const metadata: Metadata = { title: "Edit questions · Quizzz" };
export const dynamic = "force-dynamic";

export default async function EditSetPage({
  params,
  searchParams,
}: {
  params: Promise<{ setId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requirePageUser();
  const db = getDb();
  const setId = await idParam(params, "setId");
  const filter = parseFilter((await searchParams).filter);
  const set = await orNotFound(getQuestionSet(db, user.id, setId));
  const [course, questions, history, pendingRewrites] = await Promise.all([
    getCourse(db, user.id, set.courseId),
    listQuestions(db, user.id, setId),
    listSetHistory(db, user.id, setId),
    listPendingRewritesForSet(db, user.id, setId),
  ]);
  // Dates become strings across the server/client boundary.
  const initial = JSON.parse(JSON.stringify(questions)) as OwnerQuestionView[];
  const counts = countPlayability(
    questions.map((q) => ({
      status: q.status,
      evidenceStatus: q.evidenceStatus,
      answerKind: q.answerKey.kind,
    })),
  );

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
            {counts.playable !== counts.total ? ` · ${counts.playable} ready to practise` : ""}
          </p>
        </div>
        <StartPracticeButton
          questionSetId={set.id}
          disabled={counts.playable === 0}
          label="Practice this set"
        />
      </div>

      <PracticeBlockedNotice questionSetId={set.id} counts={counts} inEditor />

      <QuestionEditor
        questionSetId={set.id}
        questions={initial}
        filter={filter}
        maxImageBytes={getEnv().MAX_IMAGE_BYTES}
        aiEnabled={getEnv().AI_PROVIDER !== "disabled"}
        rewrites={JSON.parse(JSON.stringify(pendingRewrites))}
      />

      <AssistantPanel
        enabled={getEnv().AI_PROVIDER !== "disabled"}
        questionSetId={set.id}
        courseId={course.id}
        setTitle={set.title}
        questions={initial}
      />

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
