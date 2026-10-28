"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/client/api";
import type { OwnerQuestionView, RewriteProposalView, SavedRewriteView } from "@/lib/client/types";
import { REWRITE_MODE_LABELS, REWRITE_MODES, hasNumbers, type RewriteMode } from "@/lib/rewrite";
import { Alert } from "../../ui/Alert";
import { changedParts, contentFromQuestion } from "./content";
import { RewritePreview } from "./RewritePreview";

type Props = {
  question: OwnerQuestionView;
  rewrites: SavedRewriteView[];
  /** Whether the server can ask the AI. Saved proposals can still be accepted or dismissed. */
  aiEnabled: boolean;
};

export function QuestionRewrite({ question, rewrites, aiEnabled }: Props) {
  const router = useRouter();
  const [generating, setGenerating] = useState<RewriteMode | null>(null);
  const [proposal, setProposal] = useState<RewriteProposalView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const original = contentFromQuestion(question);
  const canRewrite = aiEnabled && question.answerKey.kind !== "unresolved";

  async function generate(mode: RewriteMode) {
    setError(null);
    setProposal(null);
    setGenerating(mode);
    try {
      const { proposal } = await apiFetch<{ proposal: RewriteProposalView }>(
        `/api/ai/questions/${question.id}/rewrite`,
        { body: { mode } },
      );
      setProposal(proposal);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGenerating(null);
    }
  }

  async function save() {
    if (!proposal) return;
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/api/questions/${question.id}/rewrites`, {
        body: {
          mode: proposal.mode,
          baseRevisionId: proposal.baseRevisionId,
          content: proposal.content,
        },
      });
      setProposal(null);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!canRewrite && rewrites.length === 0) return null;

  return (
    <div className="stack-sm" style={{ marginTop: "0.75rem" }}>
      {canRewrite ? (
        <div className="row" role="group" aria-label="Rewrite with AI">
          <span className="small muted">Rewrite with AI:</span>
          {REWRITE_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className="btn btn-small"
              disabled={
                generating !== null ||
                (mode === "vary_numbers" &&
                  !hasNumbers(question as { prompt: string; codeSnippet: string | null }))
              }
              onClick={() => generate(mode)}
            >
              {generating === mode ? "Thinking…" : REWRITE_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}

      {proposal ? (
        <div className="card stack-sm" aria-live="polite" aria-label="Proposed rewrite">
          <h3>
            {REWRITE_MODE_LABELS[proposal.mode]}: proposal{" "}
            {proposal.evidenceStatus === "needs_review" ? (
              <span className="badge badge-bad">Needs review</span>
            ) : (
              <span className="badge badge-warn">AI-proposed</span>
            )}
          </h3>
          {proposal.warnings.map((w) => (
            <Alert key={w} tone="warning">
              {w}
            </Alert>
          ))}
          <div className="grid">
            <RewritePreview title="Original" content={original} />
            <RewritePreview
              title="Proposed"
              content={proposal.content}
              changed={changedParts(original, proposal.content)}
            />
          </div>
          <p className="hint">
            Nothing changes until you save this and accept it. The question stays as it is
            meanwhile.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary btn-small"
              onClick={save}
              disabled={busy}
            >
              {busy ? "Saving…" : "Save proposal"}
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setProposal(null)}
              disabled={busy}
            >
              Discard
            </button>
          </div>
        </div>
      ) : null}

      {rewrites.map((rewrite) => (
        <SavedRewrite key={rewrite.id} rewrite={rewrite} original={original} />
      ))}
    </div>
  );
}

function SavedRewrite({
  rewrite,
  original,
}: {
  rewrite: SavedRewriteView;
  original: ReturnType<typeof contentFromQuestion>;
}) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await action();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const accept = (as: "revision" | "new_question") =>
    run(() => apiFetch(`/api/rewrites/${rewrite.id}/accept`, { body: { confirmed: true, as } }));
  const dismiss = () =>
    run(() => apiFetch(`/api/rewrites/${rewrite.id}/dismiss`, { method: "POST" }));

  return (
    <div
      className="card stack-sm"
      role="group"
      aria-label={`Saved ${REWRITE_MODE_LABELS[rewrite.mode]} proposal`}
    >
      <h3>
        {REWRITE_MODE_LABELS[rewrite.mode]}: saved proposal{" "}
        {rewrite.evidenceStatus === "needs_review" ? (
          <span className="badge badge-bad">Needs review</span>
        ) : (
          <span className="badge badge-warn">AI-proposed</span>
        )}
      </h3>
      {rewrite.stale ? (
        <Alert tone="warning">
          The question has changed since this was made, so it can only be added as a new question.
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid">
        <RewritePreview title="Current question" content={original} />
        <RewritePreview
          title="Proposal"
          content={rewrite.content}
          changed={changedParts(original, rewrite.content)}
        />
      </div>
      <label className="row">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          disabled={busy}
        />
        I have checked this question and its answer
      </label>
      <div className="row">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={busy || !confirmed || rewrite.stale}
          onClick={() => accept("revision")}
        >
          Use as a new version of this question
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={busy || !confirmed}
          onClick={() => accept("new_question")}
        >
          Add as a new question
        </button>
        <button type="button" className="btn btn-small btn-quiet" disabled={busy} onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
