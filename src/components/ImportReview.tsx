"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { apiFetch, errorMessage } from "@/lib/client/api";
import {
  describeAnchor,
  type ImportItemView,
  type ImportOption,
  type ImportQuestionPayload,
  type ImportView,
} from "@/lib/client/types";
import { Alert } from "./ui/Alert";

type Props = {
  initial: ImportView;
  existingSets: { id: string; title: string }[];
  defaultTitle: string;
};

const DECISION_LABEL: Record<ImportItemView["decision"], string> = {
  pending: "Not reviewed",
  accepted: "Accepted",
  edited: "Edited and accepted",
  excluded: "Excluded",
};

function isQuestion(
  item: ImportItemView,
): item is ImportItemView & { payload: ImportQuestionPayload } {
  return item.payload.kind === "question";
}

export function ImportReview({ initial, existingSets, defaultTitle }: Props) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [published, setPublished] = useState<{
    questionSetId: string;
    published: number;
    unresolved: number;
  } | null>(null);

  const questions = draft.items.filter(isQuestion);
  const chosen = questions.filter((q) => q.decision === "accepted" || q.decision === "edited");
  const unresolvedChosen = chosen.filter((q) => q.payload.correctOptionIds.length === 0);
  const isPublished = draft.status === "published";

  async function patch(itemId: string, body: unknown) {
    setError(null);
    setBusy(itemId);
    try {
      const { import: next } = await apiFetch<{ import: ImportView }>(
        `/api/imports/${draft.id}/items/${itemId}`,
        { method: "PATCH", body },
      );
      setDraft(next);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (draft.status === "failed") {
    return (
      <div className="stack page-narrow">
        <h1>Import failed</h1>
        <Alert tone="error">{draft.errorMessage ?? "This file could not be read."}</Alert>
        <p>
          <Link className="btn" href={`/courses/${draft.courseId}/import`}>
            Try another file
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Review import</h1>
          <p className="muted">
            {draft.source?.filename} · {questions.length}{" "}
            {questions.length === 1 ? "question" : "questions"} found
          </p>
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {isPublished ? (
        <Alert tone="success">
          This import is published.{" "}
          {draft.publishedQuestionSetId ? (
            <Link href={`/question-sets/${draft.publishedQuestionSetId}/edit`}>
              Open the question set
            </Link>
          ) : null}
        </Alert>
      ) : null}

      {draft.warnings.length > 0 ? (
        <section className="card" aria-labelledby="warnings-heading">
          <h2 id="warnings-heading">Things to check</h2>
          <ul className="list">
            {draft.warnings.map((w, i) => (
              <li key={`${w.code}-${i}`}>
                <span className="badge badge-warn">{w.code.replaceAll("_", " ")}</span> {w.message}{" "}
                <span className="muted small">{describeAnchor(w.anchor)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {draft.items.length === 0 ? (
        <div className="card empty">
          <p>
            <strong>No questions were found in this document.</strong>
          </p>
          <p>Check the warnings above, or write the questions yourself in the editor.</p>
        </div>
      ) : (
        <ol className="list" aria-label="Detected questions">
          {draft.items.map((item) => (
            <li key={item.id} style={{ padding: 0, border: 0, marginBottom: "1rem" }}>
              <ImportItemCard
                item={item}
                locked={isPublished}
                busy={busy === item.id}
                onDecision={(decision) => patch(item.id, { decision })}
                onSaveEdit={(edit) => patch(item.id, { edit, decision: "accepted" })}
              />
            </li>
          ))}
        </ol>
      )}

      {!isPublished ? (
        <PublishPanel
          importId={draft.id}
          chosenCount={chosen.length}
          unresolvedCount={unresolvedChosen.length}
          existingSets={existingSets}
          defaultTitle={defaultTitle}
          onPublished={(result) => {
            setPublished(result);
            setDraft((d) => ({
              ...d,
              status: "published",
              publishedQuestionSetId: result.questionSetId,
            }));
          }}
        />
      ) : null}

      {published ? (
        <Alert tone="success">
          Published {published.published} {published.published === 1 ? "question" : "questions"}.
          {published.unresolved > 0
            ? ` ${published.unresolved} without a known answer were added as excluded; set their answers in the editor to practise them.`
            : ""}{" "}
          <Link href={`/question-sets/${published.questionSetId}/edit`}>Open the question set</Link>
        </Alert>
      ) : null}
    </div>
  );
}

function ImportItemCard({
  item,
  locked,
  busy,
  onDecision,
  onSaveEdit,
}: {
  item: ImportItemView;
  locked: boolean;
  busy: boolean;
  onDecision: (decision: "pending" | "accepted" | "excluded") => Promise<boolean>;
  onSaveEdit: (edit: Record<string, unknown>) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);

  if (item.payload.kind === "material") {
    return (
      <details className="card">
        <summary>
          Text between questions <span className="muted small">(not imported as a question)</span>
        </summary>
        <p className="small" style={{ whiteSpace: "pre-wrap" }}>
          {item.payload.text}
        </p>
      </details>
    );
  }

  const payload = item.payload;
  const unresolved = payload.correctOptionIds.length === 0;
  const tone =
    item.decision === "excluded"
      ? "badge-bad"
      : item.decision === "pending"
        ? "badge-warn"
        : "badge-ok";

  return (
    <article className="card question-card" aria-label={`Question ${item.position + 1}`}>
      <div className="row row-between">
        <span className="row">
          <strong>Question {item.position + 1}</strong>
          <span className={`badge ${tone}`}>{DECISION_LABEL[item.decision]}</span>
          {unresolved ? <span className="badge badge-warn">Answer not found</span> : null}
          {payload.type === "mcq_multi" ? <span className="badge">Multiple answers</span> : null}
        </span>
      </div>

      {item.warnings.length > 0 ? (
        <ul className="small" style={{ margin: "0.5rem 0" }}>
          {item.warnings.map((w, i) => (
            <li key={`${w.code}-${i}`}>{w.message}</li>
          ))}
        </ul>
      ) : null}

      {editing ? (
        <ItemEditor
          payload={payload}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (edit) => {
            if (await onSaveEdit(edit)) setEditing(false);
          }}
        />
      ) : (
        <>
          <p className="question-prompt">{payload.prompt}</p>
          {payload.codeSnippet ? <pre className="code">{payload.codeSnippet}</pre> : null}
          <ul className="options">
            {payload.options.map((o) => {
              const correct = payload.correctOptionIds.includes(o.id);
              return (
                <li key={o.id} className={`option ${correct ? "option-correct" : ""}`}>
                  <span>
                    {o.text}
                    {correct ? <strong> — marked correct</strong> : null}
                  </span>
                </li>
              );
            })}
          </ul>
          {unresolved ? (
            <p className="hint" style={{ marginTop: "0.5rem" }}>
              No answer was marked in the document. Edit the question to choose one, or accept it as
              is: it will be added excluded until you set an answer.
            </p>
          ) : null}
          {item.sources.length > 0 ? (
            <details style={{ marginTop: "0.5rem" }}>
              <summary className="small">Source text</summary>
              {item.sources.map((s) => (
                <p key={s.ordinal} className="small muted" style={{ whiteSpace: "pre-wrap" }}>
                  {s.text}
                </p>
              ))}
            </details>
          ) : null}
          {!locked ? (
            <div className="row" style={{ marginTop: "0.75rem" }}>
              <button
                type="button"
                className="btn btn-small"
                disabled={busy || item.decision === "accepted" || item.decision === "edited"}
                onClick={() => onDecision("accepted")}
              >
                Accept
              </button>
              <button
                type="button"
                className="btn btn-small"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn btn-small"
                disabled={busy || item.decision === "excluded"}
                onClick={() => onDecision("excluded")}
              >
                Exclude
              </button>
              {item.decision !== "pending" ? (
                <button
                  type="button"
                  className="btn btn-small btn-quiet"
                  disabled={busy}
                  onClick={() => onDecision("pending")}
                >
                  Undo
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}

function ItemEditor({
  payload,
  busy,
  onSave,
  onCancel,
}: {
  payload: ImportQuestionPayload;
  busy: boolean;
  onSave: (edit: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState(payload.prompt);
  const [type, setType] = useState(payload.type);
  const [options, setOptions] = useState<ImportOption[]>(payload.options);
  const [correct, setCorrect] = useState<string[]>(payload.correctOptionIds);
  const [problem, setProblem] = useState<string | null>(null);

  function toggle(id: string) {
    setCorrect((current) =>
      type === "mcq_single"
        ? [id]
        : current.includes(id)
          ? current.filter((c) => c !== id)
          : [...current, id],
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return setProblem("The question needs text.");
    if (options.some((o) => !o.text.trim())) return setProblem("Every option needs text.");
    if (options.length < 2) return setProblem("Keep at least two options.");
    setProblem(null);
    onSave({
      type,
      prompt: prompt.trim(),
      options: options.map((o) => ({ ...o, text: o.text.trim() })),
      correctOptionIds: type === "mcq_single" ? correct.slice(0, 1) : correct,
    });
  }

  return (
    <form className="form-grid" onSubmit={submit}>
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <div className="field">
        <label htmlFor={`prompt-${payload.options[0]?.id}`}>Question</label>
        <textarea
          id={`prompt-${payload.options[0]?.id}`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Answer type</label>
        <select
          value={type}
          onChange={(e) => {
            const next = e.target.value as typeof type;
            setType(next);
            if (next === "mcq_single") setCorrect((c) => c.slice(0, 1));
          }}
        >
          <option value="mcq_single">One correct answer</option>
          <option value="mcq_multi">Several correct answers</option>
        </select>
      </div>
      <fieldset>
        <legend>Options (select the correct {type === "mcq_single" ? "one" : "ones"})</legend>
        <div className="stack-sm">
          {options.map((o, i) => (
            <div key={o.id} className="option-edit">
              <input
                type={type === "mcq_single" ? "radio" : "checkbox"}
                name="correct"
                checked={correct.includes(o.id)}
                onChange={() => toggle(o.id)}
                aria-label={`Option ${i + 1} is correct`}
              />
              <input
                type="text"
                value={o.text}
                aria-label={`Option ${i + 1} text`}
                onChange={(e) =>
                  setOptions((all) =>
                    all.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)),
                  )
                }
              />
              <button
                type="button"
                className="btn btn-small btn-quiet"
                disabled={options.length <= 2}
                onClick={() => {
                  setOptions((all) => all.filter((x) => x.id !== o.id));
                  setCorrect((c) => c.filter((id) => id !== o.id));
                }}
                aria-label={`Remove option ${i + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <button
            type="button"
            className="btn btn-small"
            disabled={options.length >= 10}
            onClick={() => {
              let n = options.length + 1;
              while (options.some((o) => o.id === `o${n}`)) n++;
              setOptions((all) => [...all, { id: `o${n}`, text: "" }]);
            }}
          >
            Add option
          </button>
          <button type="button" className="btn btn-small btn-quiet" onClick={() => setCorrect([])}>
            No answer known
          </button>
        </div>
      </fieldset>
      <div className="row">
        <button type="submit" className="btn btn-primary btn-small" disabled={busy}>
          {busy ? "Saving…" : "Save and accept"}
        </button>
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function PublishPanel({
  importId,
  chosenCount,
  unresolvedCount,
  existingSets,
  defaultTitle,
  onPublished,
}: {
  importId: string;
  chosenCount: number;
  unresolvedCount: number;
  existingSets: { id: string; title: string }[];
  defaultTitle: string;
  onPublished: (r: { questionSetId: string; published: number; unresolved: number }) => void;
}) {
  const [target, setTarget] = useState<"new" | "existing">("new");
  const [title, setTitle] = useState(defaultTitle);
  const [setId, setSetId] = useState(existingSets[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function publish(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result = await apiFetch<{
        questionSetId: string;
        published: number;
        unresolved: number;
      }>(`/api/imports/${importId}/publish`, {
        body: target === "new" ? { title: title.trim() } : { questionSetId: setId },
      });
      onPublished(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={publish} aria-labelledby="publish-heading">
      <h2 id="publish-heading">Publish</h2>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <p className="muted">
        {chosenCount === 0
          ? "Accept at least one question to publish."
          : `${chosenCount} ${chosenCount === 1 ? "question" : "questions"} will be added.`}
        {unresolvedCount > 0
          ? ` ${unresolvedCount} have no known answer and will be added as excluded until you set one.`
          : ""}
      </p>
      <fieldset>
        <legend>Where should they go?</legend>
        <div className="stack-sm">
          <label className="row">
            <input type="radio" checked={target === "new"} onChange={() => setTarget("new")} /> A
            new question set
          </label>
          {target === "new" ? (
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="New question set title"
              maxLength={120}
            />
          ) : null}
          <label className="row">
            <input
              type="radio"
              checked={target === "existing"}
              disabled={existingSets.length === 0}
              onChange={() => setTarget("existing")}
            />{" "}
            An existing set in this course
          </label>
          {target === "existing" ? (
            <select
              value={setId}
              onChange={(e) => setSetId(e.target.value)}
              aria-label="Existing question set"
            >
              {existingSets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </fieldset>
      <div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending || chosenCount === 0 || (target === "new" && !title.trim())}
        >
          {pending ? "Publishing…" : "Publish accepted questions"}
        </button>
      </div>
    </form>
  );
}
