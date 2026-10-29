"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/client/api";
import type { OwnerQuestionView, SavedRewriteView } from "@/lib/client/types";
import { editorHref, matchesFilter, type QuestionFilter } from "@/lib/playability";
import { Alert } from "../ui/Alert";
import { ConfirmButton } from "../ConfirmButton";
import { TYPE_LABELS, draftFromQuestion, emptyDraft } from "./draft";
import type { ImageChange } from "./image";
import { QuestionForm } from "./QuestionForm";
import { QuestionRewrite } from "./rewrite/QuestionRewrite";

const EVIDENCE_LABEL: Record<string, { label: string; tone: string }> = {
  human_reviewed: { label: "Reviewed", tone: "badge-ok" },
  unresolved: { label: "Answer missing", tone: "badge-warn" },
  generated_unreviewed: { label: "AI-proposed, not reviewed", tone: "badge-warn" },
  needs_review: { label: "Needs review", tone: "badge-bad" },
  rejected: { label: "Rejected", tone: "badge-bad" },
  source_linked: { label: "Linked to source", tone: "badge" },
  deterministically_checked: { label: "Machine-checked", tone: "badge-ok" },
};

function AnswerSummary({ q }: { q: OwnerQuestionView }) {
  const key = q.answerKey;
  if (key.kind === "unresolved") {
    return (
      <p className="hint">
        No correct answer is set. Edit the question to choose one, then include it in practice.
      </p>
    );
  }
  if (key.kind === "options") {
    return (
      <ul className="options">
        {q.options.map((o) => {
          const correct = key.correctOptionIds.includes(o.id);
          return (
            <li key={o.id} className={`option ${correct ? "option-correct" : ""}`}>
              <span>
                {o.text}
                {correct ? <strong> — correct</strong> : null}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }
  if (key.kind === "text") {
    return (
      <p className="small">
        <strong>Accepted:</strong> {key.accepted.join(" · ")}
        {key.caseSensitive ? " (case sensitive)" : ""}
      </p>
    );
  }
  return (
    <ol className="small">
      {key.blanks.map((alts, i) => (
        <li key={i}>
          <strong>Blank {i + 1}:</strong> {alts.join(" | ")}
        </li>
      ))}
    </ol>
  );
}

const FILTER_LABEL: Record<QuestionFilter, string> = {
  all: "All",
  "needs-review": "Needs review",
  "no-answer": "No answer",
  excluded: "Excluded",
};

const FILTER_ORDER: QuestionFilter[] = ["all", "needs-review", "no-answer", "excluded"];

type Props = {
  questionSetId: string;
  /** Whether AI help is on, so the rewrite buttons can be offered. */
  aiEnabled?: boolean;
  /** Pending AI rewrites, by question id. */
  rewrites?: Record<string, SavedRewriteView[]>;
  /** Largest image the server accepts. */
  maxImageBytes?: number;
  questions: OwnerQuestionView[];
  /** From the `?filter=` URL parameter, so links such as "Review them" open the right view. */
  filter?: QuestionFilter;
};

export function QuestionEditor({
  questionSetId,
  questions,
  filter = "all",
  maxImageBytes = 2 * 1024 * 1024,
  aiEnabled = false,
  rewrites = {},
}: Props) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const toInput = (q: OwnerQuestionView) => ({
    status: q.status,
    evidenceStatus: q.evidenceStatus,
    answerKind: q.answerKey.kind,
  });
  const filterCount = (f: QuestionFilter) =>
    questions.filter((q) => matchesFilter(f, toInput(q))).length;
  const visible = questions
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => matchesFilter(filter, toInput(q)));
  const filtered = filter !== "all";

  async function run(id: string, action: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    setBusyId(id);
    try {
      await action();
      router.refresh();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function save(id: string | null, input: Record<string, unknown>, change: ImageChange) {
    setFormError(null);
    setBusyId(id ?? "new");
    let uploadedId: string | null = null;
    try {
      // The image goes up first; the question is then saved with a reference to it. Leaving the
      // field out keeps the current image, and null removes it.
      const body: Record<string, unknown> = { ...input };
      if (change.type === "remove") body.image = null;
      else if (change.type === "alt") body.image = { imageId: change.imageId, alt: change.alt };
      else if (change.type === "upload") {
        const form = new FormData();
        form.set("file", change.file);
        const { image } = await apiFetch<{ image: { id: string } }>(
          `/api/question-sets/${questionSetId}/images`,
          { formData: form },
        );
        uploadedId = image.id;
        body.image = { imageId: image.id, alt: change.alt };
      }
      if (id) await apiFetch(`/api/questions/${id}`, { method: "PATCH", body });
      else await apiFetch(`/api/question-sets/${questionSetId}/questions`, { body });
      setEditingId(null);
      setAdding(false);
      router.refresh();
    } catch (e) {
      // The question was not saved, so the picture that was just uploaded is not needed.
      if (uploadedId)
        void apiFetch(`/api/images/${uploadedId}`, { method: "DELETE" }).catch(() => {});
      setFormError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  function move(index: number, delta: -1 | 1) {
    const ids = questions.map((q) => q.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void run(questions[index]!.id, () =>
      apiFetch(`/api/question-sets/${questionSetId}/questions/order`, {
        method: "PUT",
        body: { questionIds: ids },
      }),
    );
  }

  return (
    <div className="stack">
      {error ? <Alert tone="error">{error}</Alert> : null}

      {questions.length === 0 && !adding ? (
        <div className="card empty">
          <p>
            <strong>No questions yet.</strong>
          </p>
          <p>Add your first question, or import a document from the course page.</p>
        </div>
      ) : null}

      {questions.length > 0 ? (
        <nav aria-label="Filter questions" className="row">
          {FILTER_ORDER.map((f) => (
            <Link
              key={f}
              href={editorHref(questionSetId, f)}
              className={`btn btn-small ${f === filter ? "btn-primary" : "btn-quiet"}`}
              aria-current={f === filter ? "page" : undefined}
              scroll={false}
            >
              {FILTER_LABEL[f]} ({filterCount(f)})
            </Link>
          ))}
        </nav>
      ) : null}

      {questions.length > 0 && visible.length === 0 ? (
        <div className="card empty">
          <p>No questions match this filter.</p>
          <Link href={editorHref(questionSetId, "all")}>Show all questions</Link>
        </div>
      ) : null}

      <ol className="list" aria-label="Questions">
        {visible.map(({ q, index }) => {
          const evidence = EVIDENCE_LABEL[q.evidenceStatus];
          const isEditing = editingId === q.id;
          const busy = busyId === q.id;
          return (
            <li key={q.id} style={{ padding: 0, border: 0, marginBottom: "1rem" }}>
              <article
                className={`card question-card ${q.status !== "active" ? "is-excluded" : ""}`}
                aria-label={`Question ${index + 1}`}
              >
                <div className="row row-between">
                  <span className="row">
                    <strong>{index + 1}.</strong>
                    <span className="badge">{TYPE_LABELS[q.type]}</span>
                    {q.status === "excluded" ? (
                      <span className="badge badge-bad">Excluded</span>
                    ) : null}
                    {q.status === "reported" ? (
                      <span className="badge badge-bad">Reported</span>
                    ) : null}
                    {q.answerKey.kind === "unresolved" ? (
                      <span className="badge badge-warn">Answer not set</span>
                    ) : evidence ? (
                      <span className={`badge ${evidence.tone}`}>{evidence.label}</span>
                    ) : null}
                    <span className="small muted">revision {q.revisionNumber}</span>
                  </span>
                  <span className="row">
                    {filtered ? null : (
                      <>
                        <button
                          type="button"
                          className="btn btn-small btn-quiet"
                          onClick={() => move(index, -1)}
                          disabled={index === 0 || busyId !== null}
                          aria-label={`Move question ${index + 1} up`}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-quiet"
                          onClick={() => move(index, 1)}
                          disabled={index === questions.length - 1 || busyId !== null}
                          aria-label={`Move question ${index + 1} down`}
                        >
                          ↓
                        </button>
                      </>
                    )}
                  </span>
                </div>

                {isEditing ? (
                  <div style={{ marginTop: "0.75rem" }}>
                    <QuestionForm
                      initial={draftFromQuestion(q)}
                      submitLabel="Save as new revision"
                      showApprove={q.origin !== "original"}
                      busy={busy}
                      serverError={formError}
                      onSubmit={(input, change) => save(q.id, input, change)}
                      initialImage={q.image ?? null}
                      maxImageBytes={maxImageBytes}
                      onCancel={() => {
                        setEditingId(null);
                        setFormError(null);
                      }}
                    />
                  </div>
                ) : (
                  <>
                    <p className="question-prompt" style={{ marginTop: "0.5rem" }}>
                      {q.prompt}
                    </p>
                    {q.image ? (
                      // eslint-disable-next-line @next/next/no-img-element -- an authenticated API route
                      <img className="question-image" src={q.image.url} alt={q.image.alt} />
                    ) : null}
                    {q.codeSnippet ? <pre className="code">{q.codeSnippet}</pre> : null}
                    <AnswerSummary q={q} />
                    {q.explanation ? (
                      <p className="small muted">Explanation: {q.explanation}</p>
                    ) : null}
                    <div className="row" style={{ marginTop: "0.75rem" }}>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => {
                          setEditingId(q.id);
                          setAdding(false);
                          setFormError(null);
                        }}
                      >
                        Edit
                      </button>
                      {q.status === "excluded" ? (
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={busy}
                          onClick={() =>
                            run(q.id, () =>
                              apiFetch(`/api/questions/${q.id}/restore`, { method: "POST" }),
                            )
                          }
                        >
                          Include in practice
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={busy}
                          onClick={() =>
                            run(q.id, () =>
                              apiFetch(`/api/questions/${q.id}/exclude`, { method: "POST" }),
                            )
                          }
                        >
                          Exclude
                        </button>
                      )}
                      {q.type === "mcq_single" || q.type === "mcq_multi" ? (
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={busy}
                          onClick={() =>
                            run(q.id, () =>
                              apiFetch(`/api/questions/${q.id}/shuffle-options`, {
                                method: "POST",
                              }),
                            )
                          }
                        >
                          Shuffle options
                        </button>
                      ) : null}
                      <ConfirmButton
                        label="Delete"
                        disabled={busy}
                        onConfirm={() => {
                          void run(q.id, () =>
                            apiFetch(`/api/questions/${q.id}`, { method: "DELETE" }),
                          );
                        }}
                      />
                    </div>
                    <QuestionRewrite
                      question={q}
                      aiEnabled={aiEnabled}
                      rewrites={rewrites[q.id] ?? []}
                    />
                  </>
                )}
              </article>
            </li>
          );
        })}
      </ol>

      {adding ? (
        <div className="card">
          <h2>New question</h2>
          <QuestionForm
            initial={emptyDraft()}
            submitLabel="Add question"
            showApprove={false}
            busy={busyId === "new"}
            serverError={formError}
            onSubmit={(input, change) => save(null, input, change)}
            maxImageBytes={maxImageBytes}
            onCancel={() => {
              setAdding(false);
              setFormError(null);
            }}
          />
        </div>
      ) : (
        <div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setAdding(true);
              setEditingId(null);
              setFormError(null);
            }}
          >
            Add question
          </button>
        </div>
      )}
    </div>
  );
}
