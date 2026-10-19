"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch, errorMessage } from "@/lib/client/api";
import { LANGUAGES } from "@/lib/labels";
import { Alert } from "./ui/Alert";
import { ConfirmButton } from "./ConfirmButton";
import { Field } from "./ui/Field";

type CourseValues = {
  title: string;
  subject: string;
  language: string | null;
  examDate: string | null;
};

function CourseFields({ values }: { values?: CourseValues }) {
  return (
    <>
      <Field label="Title" name="title" defaultValue={values?.title} required maxLength={120} />
      <Field
        label="Subject"
        name="subject"
        defaultValue={values?.subject}
        required
        maxLength={120}
        hint="For example: Introduction to programming"
      />
      <div className="field">
        <label htmlFor="language">Programming language</label>
        <select id="language" name="language" defaultValue={values?.language ?? ""}>
          <option value="">None (not a programming course)</option>
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <Field label="Exam date" name="examDate" type="date" defaultValue={values?.examDate ?? ""} />
    </>
  );
}

function readCourse(form: FormData) {
  return {
    title: String(form.get("title") ?? "").trim(),
    subject: String(form.get("subject") ?? "").trim(),
    language: String(form.get("language") ?? "") || null,
    examDate: String(form.get("examDate") ?? "") || null,
  };
}

export function CreateCourseForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const { course } = await apiFetch<{ course: { id: string } }>("/api/courses", {
        body: readCourse(new FormData(event.currentTarget)),
      });
      router.push(`/courses/${course.id}`);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={onSubmit}>
      <h2>New course</h2>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <CourseFields />
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Creating…" : "Create course"}
        </button>
      </div>
    </form>
  );
}

export function EditCourseForm({ courseId, values }: { courseId: string; values: CourseValues }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      await apiFetch(`/api/courses/${courseId}`, {
        method: "PATCH",
        body: readCourse(new FormData(event.currentTarget)),
      });
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setError(null);
    try {
      await apiFetch(`/api/courses/${courseId}`, { method: "DELETE" });
      router.push("/");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <form className="form-grid" onSubmit={onSubmit}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}
      <CourseFields values={values} />
      <div className="row row-between">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </button>
        <ConfirmButton label="Delete course" onConfirm={remove} />
      </div>
      <p className="hint">
        A course with study history cannot be deleted; exclude its questions instead.
      </p>
    </form>
  );
}

export function CreateSetForm({ courseId }: { courseId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    try {
      const { questionSet } = await apiFetch<{ questionSet: { id: string } }>(
        `/api/courses/${courseId}/question-sets`,
        { body: { title } },
      );
      router.push(`/question-sets/${questionSet.id}/edit`);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={onSubmit}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field
        label="New question set"
        name="title"
        required
        maxLength={120}
        placeholder="Week 1 quiz"
      />
      <div>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Creating…" : "Create question set"}
        </button>
      </div>
    </form>
  );
}
