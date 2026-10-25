import type { Metadata } from "next";
import Link from "next/link";
import { CreateSetForm, EditCourseForm } from "@/components/CourseForms";
import { NeedsReviewNote, PracticeBlockedNotice } from "@/components/PracticeBlockedNotice";
import { StartPracticeButton } from "@/components/StartPracticeButton";
import { formatDate, LANGUAGE_LABELS } from "@/lib/labels";
import { idParam, orNotFound, requirePageUser } from "@/server/auth/page";
import { getCourse } from "@/server/content/courses";
import { listCourseImports, listQuestionSetsWithCounts } from "@/server/content/overview";
import { getDb } from "@/server/db";

export const metadata: Metadata = { title: "Course · Quizzz" };
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  extracted: "Ready to review",
  published: "Published",
  failed: "Failed",
};

export default async function CoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const user = await requirePageUser();
  const db = getDb();
  const courseId = await idParam(params, "courseId");
  const course = await orNotFound(getCourse(db, user.id, courseId));
  const [sets, imports] = await Promise.all([
    listQuestionSetsWithCounts(db, user.id, courseId),
    listCourseImports(db, user.id, courseId),
  ]);

  return (
    <div className="stack">
      <p className="crumbs">
        <Link href="/">Home</Link> / {course.title}
      </p>
      <div className="page-head">
        <div>
          <h1>{course.title}</h1>
          <p className="muted">{course.subject}</p>
          <p className="row">
            {course.language ? (
              <span className="badge">{LANGUAGE_LABELS[course.language]}</span>
            ) : null}
            {course.examDate ? (
              <span className="badge">Exam {formatDate(course.examDate)}</span>
            ) : null}
          </p>
        </div>
        <Link className="btn btn-primary" href={`/courses/${course.id}/import`}>
          Import from a document
        </Link>
      </div>

      <section className="card" aria-labelledby="sets-heading">
        <h2 id="sets-heading">Question sets</h2>
        {sets.length === 0 ? (
          <p className="muted">
            No question sets yet. Import a document or create an empty set to write questions
            yourself.
          </p>
        ) : (
          <ul className="list">
            {sets.map((s) => {
              const counts = {
                total: s.questionCount,
                playable: s.playableCount,
                needsReview: s.needsReviewCount,
                noAnswer: s.noAnswerCount,
                excluded: s.excludedCount,
              };
              const hidden = s.questionCount - s.playableCount;
              return (
                <li key={s.id} className="stack-sm">
                  <div className="row row-between">
                    <span>
                      <strong>{s.title}</strong>
                      {s.origin === "sample" ? (
                        <span className="badge badge-warn">Sample</span>
                      ) : null}
                      <br />
                      <span className="small muted">
                        {s.questionCount} {s.questionCount === 1 ? "question" : "questions"}
                        {hidden > 0 ? ` · ${s.playableCount} ready to practise` : ""}
                      </span>
                    </span>
                    <span className="row">
                      <Link href={`/question-sets/${s.id}/edit`}>Edit</Link>
                      <StartPracticeButton questionSetId={s.id} disabled={s.playableCount === 0} />
                    </span>
                  </div>
                  <PracticeBlockedNotice questionSetId={s.id} counts={counts} />
                  <NeedsReviewNote questionSetId={s.id} counts={counts} />
                  {s.origin === "sample" && s.needsReviewCount > 0 ? (
                    <p className="small muted">
                      This sample content is a draft and has not been checked. Review each question
                      and tick &ldquo;approve&rdquo; when you are happy with it.
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <hr />
        <CreateSetForm courseId={course.id} />
      </section>

      <section className="card" aria-labelledby="materials-heading">
        <h2 id="materials-heading">Imported materials</h2>
        {imports.length === 0 ? (
          <p className="muted">Nothing imported yet.</p>
        ) : (
          <ul className="list">
            {imports.map((i) => (
              <li key={i.id} className="row row-between">
                <span>
                  {i.filename} <span className="muted small">· {formatDate(i.createdAt)}</span>
                </span>
                <span className="row">
                  <span
                    className={`badge ${i.status === "failed" ? "badge-bad" : i.status === "published" ? "badge-ok" : "badge-warn"}`}
                  >
                    {STATUS_LABEL[i.status] ?? i.status}
                  </span>
                  <Link href={`/imports/${i.id}`}>Open</Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="card">
        <summary>Course settings</summary>
        <div style={{ marginTop: "1rem" }}>
          <EditCourseForm
            courseId={course.id}
            values={{
              title: course.title,
              subject: course.subject,
              language: course.language,
              examDate: course.examDate,
            }}
          />
        </div>
      </details>
    </div>
  );
}
