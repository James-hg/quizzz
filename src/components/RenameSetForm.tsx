"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch, errorMessage } from "@/lib/client/api";
import { Alert } from "./ui/Alert";
import { ConfirmButton } from "./ConfirmButton";
import { Field } from "./ui/Field";

export function RenameSetForm({
  setId,
  title,
  courseId,
}: {
  setId: string;
  title: string;
  courseId: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const next = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    try {
      await apiFetch(`/api/question-sets/${setId}`, { method: "PATCH", body: { title: next } });
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function remove() {
    setError(null);
    try {
      await apiFetch(`/api/question-sets/${setId}`, { method: "DELETE" });
      router.push(`/courses/${courseId}`);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <form className="form-grid" onSubmit={rename}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}
      <Field label="Title" name="title" defaultValue={title} required maxLength={120} />
      <div className="row row-between">
        <button type="submit" className="btn">
          Rename
        </button>
        <ConfirmButton label="Delete question set" onConfirm={remove} />
      </div>
      <p className="hint">
        A set with study history cannot be deleted; exclude its questions instead.
      </p>
    </form>
  );
}
