"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiClientError, apiFetch, errorMessage } from "@/lib/client/api";
import type { SupportedFormat } from "@/lib/client/types";
import { Alert } from "./ui/Alert";

type Props = { courseId: string; formats: SupportedFormat[]; maxUploadBytes: number };

export function ImportUpload({ courseId, formats, maxUploadBytes }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [failedImportId, setFailedImportId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFailedImportId(null);
    const file = new FormData(event.currentTarget).get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a file to upload.");
      return;
    }
    const body = new FormData();
    body.set("file", file);
    setPending(true);
    try {
      const { import: draft } = await apiFetch<{ import: { id: string } }>(
        `/api/courses/${courseId}/imports`,
        { formData: body },
      );
      router.push(`/imports/${draft.id}`);
    } catch (e) {
      const names = formats.map((f) => f.label).join(", ");
      setError(
        e instanceof ApiClientError && e.code === "unsupported_format" && names
          ? `${e.message} Supported formats: ${names}.`
          : errorMessage(e),
      );
      const importId = e instanceof ApiClientError ? e.details?.importId : undefined;
      if (typeof importId === "string") setFailedImportId(importId);
      setPending(false);
    }
  }

  const names = formats.map((f) => f.label).join(", ");
  const accept = formats.map((f) => `.${f.extension}`).join(",");
  const maxMb = Math.floor(maxUploadBytes / (1024 * 1024));

  return (
    <form className="form-grid" onSubmit={onSubmit}>
      {error ? (
        <Alert tone="error">
          {error}
          {failedImportId ? (
            <>
              {" "}
              <Link href={`/imports/${failedImportId}`}>See details</Link>
            </>
          ) : null}
        </Alert>
      ) : null}
      <div className="field">
        <label htmlFor="file">Document</label>
        <input
          id="file"
          name="file"
          type="file"
          accept={accept}
          required
          aria-describedby="file-hint"
        />
        <p className="hint" id="file-hint">
          Supported: {names}. Up to {maxMb} MB. Questions are detected automatically and you review
          them before anything is saved.
        </p>
      </div>
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Uploading and reading…" : "Upload and review"}
        </button>
      </div>
    </form>
  );
}
