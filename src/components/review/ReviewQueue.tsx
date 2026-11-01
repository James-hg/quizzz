"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/client/api";
import type {
  CheckResultView,
  QueueQuestionView,
  QueueRewriteView,
  ReviewQueueView,
} from "@/lib/client/types";
import { REWRITE_MODE_LABELS } from "@/lib/rewrite";
import { Alert } from "../ui/Alert";
import { AnswerSummary } from "../editor/QuestionEditor";

const CHECK_LABEL: Record<CheckResultView["name"], string> = {
  schema_valid: "Question is well formed",
  supported_type: "Question type is supported",
  correct_option_count: "Right number of correct options",
  source_ids: "Cited passages exist and are yours",
  excerpt_fidelity: "Quoted words appear in the passage",
  explanation_answer_agreement: "Explanation names the same answer",
  imported_key_agreement: "Same answer as the imported question",
};

const RESULT_LABEL: Record<CheckResultView["result"], { text: string; tone: string }> = {
  pass: { text: "Passed", tone: "badge-good" },
  fail: { text: "Failed", tone: "badge-bad" },
  // Nothing to look at: not a pass, and not shown as one.
  not_applicable: { text: "Not checked", tone: "" },
};

const ORIGIN_LABEL: Record<string, string> = {
  ai_proposed: "AI-proposed",
  ai_variant: "AI-varied",
  sample: "Sample",
};

const REQUIRED = new Set<CheckResultView["name"]>([
  "schema_valid",
  "supported_type",
  "correct_option_count",
  "source_ids",
  "excerpt_fidelity",
  "explanation_answer_agreement",
]);

function Checks({ checks }: { checks: CheckResultView[] }) {
  return (
    <ul className="list small" aria-label="Checks">
      {checks.map((c) => {
        const label = RESULT_LABEL[c.result];
        return (
          <li key={c.name} className="row row-between">
            <span>{CHECK_LABEL[c.name]}</span>
            <span className={`badge ${label.tone}`}>{label.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Whether the required checks block approval. Recomputed by the server on every approval. */
function blocked(item: QueueQuestionView) {
  return (
    item.recordedFailures.length > 0 ||
    item.checks.some((c) => c.result === "fail" && REQUIRED.has(c.name))
  );
}

function Passage({ segmentId }: { segmentId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function open() {
    try {
      const { segment } = await apiFetch<{ segment: { text: string } }>(
        `/api/sources/segments/${segmentId}`,
      );
      setText(segment.text);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  if (error) return <span className="small">{error}</span>;
  if (text !== null) return <blockquote className="small">{text}</blockquote>;
  return (
    <button type="button" className="btn btn-small btn-quiet" onClick={open}>
      Show passage
    </button>
  );
}

function QuestionItem({
  item,
  selected,
  onSelect,
}: {
  item: QueueQuestionView;
  selected: boolean;
  onSelect: (on: boolean) => void;
}) {
  const router = useRouter();
  const q = item.question;
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stuck = blocked(item);
  const needsReason = item.keyConflict;

  async function act(action: "approve" | "reject") {
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/api/question-revisions/${q.revisionId}/${action}`, {
        body:
          action === "approve" && needsReason
            ? { confirmed: true, keyConflictReason: reason.trim() }
            : { confirmed: true },
      });
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <article className="card stack-sm" aria-label={`Review: ${q.prompt}`}>
      <div className="row row-between">
        <label className="row">
          <input
            type="checkbox"
            checked={selected}
            disabled={stuck || needsReason || busy}
            onChange={(e) => onSelect(e.target.checked)}
            aria-label={`Select: ${q.prompt}`}
          />
          <strong>{item.setTitle}</strong>
        </label>
        <span>
          <span className="badge badge-warn">{ORIGIN_LABEL[q.origin] ?? q.origin}</span>{" "}
          <span className="badge">Waiting for your review</span>
        </span>
      </div>
      <p className="question-prompt">{q.prompt}</p>
      {q.codeSnippet ? <pre className="code">{q.codeSnippet}</pre> : null}
      <AnswerSummary q={q} />
      {q.explanation ? <p className="small muted">Explanation: {q.explanation}</p> : null}

      {item.keyConflict ? (
        <Alert tone="warning">
          This answer differs from the imported one. Imported answer:{" "}
          <strong>{describeKey(item.importedKey, q)}</strong>. The imported question is not changed.
          Say why you are keeping the new answer to approve it.
        </Alert>
      ) : null}
      {stuck ? (
        <Alert tone="error">
          A required check failed, so this cannot be approved. Edit it in the question editor, or
          reject it.
        </Alert>
      ) : null}

      <Checks checks={item.checks} />
      <p className="hint">
        Checks find structural problems. They cannot tell whether an answer is right, so you decide.
      </p>

      {item.citations.length > 0 ? (
        <div className="stack-sm">
          <strong className="small">Sources</strong>
          {item.citations.map((c) => (
            <div key={c.segmentId} className="small">
              {c.filename}, {c.location}
              {c.excerpt ? <> — quoted: “{c.excerpt}”</> : null} <Passage segmentId={c.segmentId} />
            </div>
          ))}
        </div>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}
      <label className="row">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          disabled={busy}
        />
        I have checked this question and its answer
      </label>
      {needsReason ? (
        <label className="field">
          <span>Why keep this answer?</span>
          <textarea
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
          />
        </label>
      ) : null}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={busy || stuck || !confirmed || (needsReason && !reason.trim())}
          onClick={() => act("approve")}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={busy}
          onClick={() => act("reject")}
        >
          Reject
        </button>
        <Link className="btn btn-small btn-quiet" href={`/question-sets/${item.setId}/edit`}>
          Edit
        </Link>
      </div>
    </article>
  );
}

function describeKey(key: QueueQuestionView["importedKey"], q: QueueQuestionView["question"]) {
  if (!key) return "unknown";
  if (key.kind === "options") {
    return key.correctOptionIds
      .map((id) => q.options.find((o) => o.id === id)?.text ?? id)
      .join(", ");
  }
  if (key.kind === "text") return key.accepted.join(" · ");
  if (key.kind === "blanks") return key.blanks.map((b) => b.join(" | ")).join(" ; ");
  return "none";
}

function RewriteItem({ item }: { item: QueueRewriteView }) {
  return (
    <article className="card stack-sm" aria-label={`Rewrite: ${item.content.prompt}`}>
      <div className="row row-between">
        <strong>{item.setTitle}</strong>
        <span>
          <span className="badge badge-warn">AI rewrite: {REWRITE_MODE_LABELS[item.mode]}</span>
          {item.stale ? <span className="badge badge-bad">Out of date</span> : null}
        </span>
      </div>
      <p className="question-prompt">{item.content.prompt}</p>
      <Checks checks={item.checks} />
      {item.keyConflict ? (
        <Alert tone="warning">
          This changes the answer from the imported one. You will be asked why when you accept it.
        </Alert>
      ) : null}
      <Link className="btn btn-small" href={`/question-sets/${item.setId}/edit`}>
        Review in the editor
      </Link>
    </article>
  );
}

export function ReviewQueue({ courseId, queue }: { courseId: string; queue: ReviewQueueView }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectable = queue.questions.filter((i) => !blocked(i) && !i.keyConflict);
  // Only ids that are still in the queue count, so nothing stale stays ticked after a refresh.
  const chosen = [...selected].filter((id) =>
    queue.questions.some((i) => i.question.revisionId === id),
  );

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function approveSelected() {
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/api/courses/${courseId}/review-queue/approve-selected`, {
        body: { confirmed: true, revisionIds: chosen },
      });
      setSelected(new Set());
      setConfirmed(false);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (queue.questions.length === 0 && queue.rewrites.length === 0) {
    return (
      <p className="muted">
        Nothing is waiting for review. AI-proposed questions, sample questions and AI rewrites show
        up here.
      </p>
    );
  }

  return (
    <div className="stack">
      {queue.questions.length > 0 ? (
        <section className="stack" aria-labelledby="queue-questions">
          <div className="row row-between">
            <h2 id="queue-questions">Questions ({queue.questions.length})</h2>
            <button
              type="button"
              className="btn btn-small"
              onClick={() =>
                setSelected(new Set(selectable.slice(0, 50).map((i) => i.question.revisionId)))
              }
              disabled={selectable.length === 0 || busy}
            >
              Select all that can be approved
            </button>
          </div>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="card row">
            <label className="row">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={busy}
              />
              I have checked the selected questions and their answers
            </label>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={busy || !confirmed || chosen.length === 0}
              onClick={approveSelected}
            >
              Approve selected ({chosen.length})
            </button>
          </div>
          {queue.questions.map((item) => (
            <QuestionItem
              key={item.question.revisionId}
              item={item}
              selected={selected.has(item.question.revisionId)}
              onSelect={(on) => toggle(item.question.revisionId, on)}
            />
          ))}
        </section>
      ) : null}

      {queue.rewrites.length > 0 ? (
        <section className="stack" aria-labelledby="queue-rewrites">
          <h2 id="queue-rewrites">AI rewrites ({queue.rewrites.length})</h2>
          {queue.rewrites.map((r) => (
            <RewriteItem key={r.id} item={r} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
