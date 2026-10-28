"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IMAGE_MIME_TYPES, IMAGE_TYPE_LABEL } from "@/lib/images";
import { fileProblem, imageProblem, type ImageValue } from "./image";

type Props = {
  value: ImageValue;
  onChange: (value: ImageValue) => void;
  maxBytes: number;
  /** Show the alt-text problem (after a failed save). */
  showErrors?: boolean;
};

/** Attach, describe, replace or remove the picture a question shows. Alt text is required. */
export function ImageField({ value, onChange, maxBytes, showErrors }: Props) {
  const uid = useId();
  const [fileError, setFileError] = useState<string | null>(null);
  const previews = useRef<string[]>([]);

  // Free the temporary preview URLs when the field goes away.
  useEffect(() => {
    const urls = previews.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  function choose(file: File | undefined) {
    if (!file) return;
    const problem = fileProblem(file, maxBytes);
    setFileError(problem);
    if (problem) return;
    const previewUrl = URL.createObjectURL(file);
    previews.current.push(previewUrl);
    onChange({ kind: "new", file, previewUrl, alt: value?.alt ?? "" });
  }

  const altError = showErrors ? imageProblem(value) : null;
  const src = value ? (value.kind === "new" ? value.previewUrl : value.url) : null;

  return (
    <fieldset aria-describedby={fileError || altError ? `${uid}-err` : undefined}>
      <legend>Image (optional)</legend>
      {value && src ? (
        <div className="stack-sm">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local preview or an authenticated API route */}
          <img
            className="question-image"
            src={src}
            alt={value.alt || "Preview of the chosen image"}
          />
          <div className="field">
            <label htmlFor={`${uid}-alt`}>Describe the image</label>
            <input
              id={`${uid}-alt`}
              type="text"
              value={value.alt}
              maxLength={300}
              aria-invalid={altError ? true : undefined}
              onChange={(e) => onChange({ ...value, alt: e.target.value })}
            />
            <p className="hint">Read aloud to people who cannot see the picture. Required.</p>
          </div>
        </div>
      ) : null}
      <div className="row" style={{ marginTop: "0.5rem" }}>
        <label className="btn btn-small" htmlFor={`${uid}-file`}>
          {value ? "Replace image" : "Add image"}
        </label>
        <input
          id={`${uid}-file`}
          className="visually-hidden"
          type="file"
          accept={IMAGE_MIME_TYPES.join(",")}
          aria-label={value ? "Choose a replacement image" : "Choose an image"}
          onChange={(e) => {
            choose(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {value ? (
          <button
            type="button"
            className="btn btn-small btn-quiet"
            onClick={() => {
              setFileError(null);
              onChange(null);
            }}
          >
            Remove image
          </button>
        ) : null}
        <span className="hint">
          {IMAGE_TYPE_LABEL}, up to{" "}
          {Math.max(1, Math.round(maxBytes / 1024)) >= 1024
            ? `${Math.round(maxBytes / 1024 / 1024)} MB`
            : `${Math.round(maxBytes / 1024)} KB`}
          .
        </span>
      </div>
      <div id={`${uid}-err`}>
        {fileError ? <p className="field-error">{fileError}</p> : null}
        {altError ? <p className="field-error">{altError}</p> : null}
      </div>
    </fieldset>
  );
}
