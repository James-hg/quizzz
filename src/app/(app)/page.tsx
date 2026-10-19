import type { Metadata } from "next";
import Link from "next/link";
import { CreateCourseForm } from "@/components/CourseForms";
import { formatDate, LANGUAGE_LABELS } from "@/lib/labels";
import { requirePageUser } from "@/server/auth/page";
import { listCourses } from "@/server/content/courses";
import { listLiveSessions, listRecentQuestionSets } from "@/server/content/overview";
import { getDb } from "@/server/db";

export const metadata: Metadata = { title: "Home · Quizzz" };
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await requirePageUser();
  const db = getDb();
  const [courses, live, recent] = await Promise.all([
    listCourses(db, user.id),
    listLiveSessions(db, user.id),
    listRecentQuestionSets(db, user.id),
  ]);

  return (
    <div className="stack">
      <h1>Your courses</h1>

      {live.length > 0 ? (
        <section aria-labelledby="continue-heading" className="card">
          <h2 id="continue-heading">Continue where you left off</h2>
          <ul className="list">
            {live.map((s) => (
              <li key={s.sessionId} className="row row-between">
                <span>
                  <strong>{s.setTitle}</strong> <span className="muted">· {s.courseTitle}</span>
                  <br />
                  <span className="small muted">
                    {s.answered} of {s.total} answered {s.state === "paused" ? "· paused" : ""}
                  </span>
                </span>
                <Link
                  className="btn btn-primary"
                  href={`/question-sets/${s.questionSetId}/play/${s.sessionId}`}
                >
                  Resume
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {courses.length === 0 ? (
        <div className="card empty">
          <p>
            <strong>No courses yet.</strong>
          </p>
          <p>Create a course, then import a document or write your own questions.</p>
        </div>
      ) : (
        <ul className="grid list" aria-label="Courses">
          {courses.map((c) => (
            <li key={c.id} style={{ padding: 0, border: 0 }}>
              <Link className="card card-link" href={`/courses/${c.id}`}>
                <h3>{c.title}</h3>
                <p className="muted small">{c.subject}</p>
                <p className="row small">
                  {c.language ? <span className="badge">{LANGUAGE_LABELS[c.language]}</span> : null}
                  {c.examDate ? <span className="badge">Exam {formatDate(c.examDate)}</span> : null}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {recent.length > 0 ? (
        <section aria-labelledby="recent-heading" className="card">
          <h2 id="recent-heading">Recent question sets</h2>
          <ul className="list">
            {recent.map((s) => (
              <li key={s.id} className="row row-between">
                <span>
                  {s.title} <span className="muted small">· {s.courseTitle}</span>
                </span>
                <span className="row">
                  <Link href={`/question-sets/${s.id}/edit`}>Edit</Link>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <CreateCourseForm />
    </div>
  );
}
