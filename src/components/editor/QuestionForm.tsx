"use client";

import { useId, useState, type FormEvent } from "react";
import { Alert } from "../ui/Alert";
import {
  TYPE_LABELS,
  changeType,
  nextOptionId,
  parseAlternatives,
  validateDraft,
  type DraftErrors,
  type QuestionDraft,
} from "./draft";
import type { QuestionType } from "@/lib/client/types";

type Props = {
  initial: QuestionDraft;
  submitLabel: string;
  busy?: boolean;
  serverError?: string | null;
  onSubmit: (input: Record<string, unknown>) => void | Promise<void>;
  onCancel?: () => void;
};

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p className="field-error" id={id}>
      {message}
    </p>
  ) : null;
}

export function QuestionForm({
  initial,
  submitLabel,
  busy,
  serverError,
  onSubmit,
  onCancel,
}: Props) {
  const uid = useId();
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const set = (patch: Partial<QuestionDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const isMcq = draft.type === "mcq_single" || draft.type === "mcq_multi";
  const caseApplies = !isMcq;

  function toggleCorrect(id: string) {
    set({
      correctOptionIds:
        draft.type === "mcq_single"
          ? [id]
          : draft.correctOptionIds.includes(id)
            ? draft.correctOptionIds.filter((c) => c !== id)
            : [...draft.correctOptionIds, id],
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = validateDraft(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    await onSubmit({ ...result.input, approve: draft.approve });
  }

  const errorList = Object.values(errors);

  return (
    <form className="form-grid" onSubmit={submit} noValidate aria-label="Question form">
      {serverError ? <Alert tone="error">{serverError}</Alert> : null}
      {errorList.length > 0 ? (
        <Alert tone="error">
          Fix {errorList.length === 1 ? "this" : "these"} before saving: {errorList.join(" ")}
        </Alert>
      ) : null}

      <div className="field">
        <label htmlFor={`${uid}-type`}>Question type</label>
        <select
          id={`${uid}-type`}
          value={draft.type}
          onChange={(e) => setDraft((d) => changeType(d, e.target.value as QuestionType))}
        >
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={`${uid}-prompt`}>Question</label>
        <textarea
          id={`${uid}-prompt`}
          value={draft.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          aria-invalid={errors.prompt ? true : undefined}
          aria-describedby={errors.prompt ? `${uid}-prompt-err` : undefined}
        />
        <FieldError id={`${uid}-prompt-err`} message={errors.prompt} />
      </div>

      <div className="field">
        <label htmlFor={`${uid}-code`}>Code (optional)</label>
        <textarea
          id={`${uid}-code`}
          className="mono"
          value={draft.codeSnippet}
          onChange={(e) => set({ codeSnippet: e.target.value })}
          spellCheck={false}
        />
      </div>

      {isMcq ? (
        <fieldset
          aria-describedby={
            errors.options || errors.correctOptionIds ? `${uid}-opt-err` : undefined
          }
        >
          <legend>
            Options (select the correct {draft.type === "mcq_single" ? "one" : "ones"})
          </legend>
          <div className="stack-sm">
            {draft.options.map((o, i) => (
              <div key={o.id} className="option-edit">
                <input
                  type={draft.type === "mcq_single" ? "radio" : "checkbox"}
                  name={`${uid}-correct`}
                  checked={draft.correctOptionIds.includes(o.id)}
                  onChange={() => toggleCorrect(o.id)}
                  aria-label={`Option ${i + 1} is correct`}
                />
                <input
                  type="text"
                  value={o.text}
                  aria-label={`Option ${i + 1} text`}
                  onChange={(e) =>
                    set({
                      options: draft.options.map((x) =>
                        x.id === o.id ? { ...x, text: e.target.value } : x,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  className="btn btn-small btn-quiet"
                  disabled={draft.options.length <= 2}
                  aria-label={`Remove option ${i + 1}`}
                  onClick={() =>
                    set({
                      options: draft.options.filter((x) => x.id !== o.id),
                      correctOptionIds: draft.correctOptionIds.filter((id) => id !== o.id),
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div style={{ marginTop: "0.5rem" }}>
            <button
              type="button"
              className="btn btn-small"
              disabled={draft.options.length >= 10}
              onClick={() =>
                set({ options: [...draft.options, { id: nextOptionId(draft.options), text: "" }] })
              }
            >
              Add option
            </button>
          </div>
          <div id={`${uid}-opt-err`}>
            <FieldError id={`${uid}-opt-e1`} message={errors.options} />
            <FieldError id={`${uid}-opt-e2`} message={errors.correctOptionIds} />
          </div>
        </fieldset>
      ) : null}

      {draft.type === "short_answer" || draft.type === "output_prediction" ? (
        <fieldset aria-describedby={errors.accepted ? `${uid}-acc-err` : undefined}>
          <legend>
            {draft.type === "output_prediction" ? "Accepted output" : "Accepted answers"}
          </legend>
          <div className="stack-sm">
            {draft.accepted.map((a, i) => (
              <div key={i} className="row">
                <textarea
                  style={{
                    minHeight: draft.type === "output_prediction" ? "4rem" : "2.5rem",
                    flex: 1,
                  }}
                  className={draft.type === "output_prediction" ? "mono" : undefined}
                  value={a}
                  aria-label={`Accepted answer ${i + 1}`}
                  onChange={(e) =>
                    set({ accepted: draft.accepted.map((x, j) => (j === i ? e.target.value : x)) })
                  }
                />
                <button
                  type="button"
                  className="btn btn-small btn-quiet"
                  disabled={draft.accepted.length <= 1}
                  aria-label={`Remove accepted answer ${i + 1}`}
                  onClick={() => set({ accepted: draft.accepted.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div style={{ marginTop: "0.5rem" }}>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => set({ accepted: [...draft.accepted, ""] })}
            >
              Add another accepted answer
            </button>
          </div>
          <FieldError id={`${uid}-acc-err`} message={errors.accepted} />
        </fieldset>
      ) : null}

      {draft.type === "fill_blank" ? (
        <fieldset aria-describedby={errors.blanks ? `${uid}-blank-err` : undefined}>
          <legend>Blanks</legend>
          <p className="hint">Write the accepted answers for each blank, separated by |</p>
          <div className="stack-sm">
            {draft.blanks.map((alts, i) => (
              <div key={i} className="row">
                <input
                  type="text"
                  style={{ flex: 1 }}
                  defaultValue={alts.join(" | ")}
                  aria-label={`Blank ${i + 1} accepted answers`}
                  onChange={(e) =>
                    set({
                      blanks: draft.blanks.map((x, j) =>
                        j === i ? parseAlternatives(e.target.value) : x,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  className="btn btn-small btn-quiet"
                  disabled={draft.blanks.length <= 1}
                  aria-label={`Remove blank ${i + 1}`}
                  onClick={() => set({ blanks: draft.blanks.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div style={{ marginTop: "0.5rem" }}>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => set({ blanks: [...draft.blanks, []] })}
            >
              Add blank
            </button>
          </div>
          <FieldError id={`${uid}-blank-err`} message={errors.blanks} />
        </fieldset>
      ) : null}

      {caseApplies ? (
        <label className="row">
          <input
            type="checkbox"
            checked={draft.caseSensitive}
            onChange={(e) => set({ caseSensitive: e.target.checked })}
          />
          Case sensitive
        </label>
      ) : null}

      <div className="field">
        <label htmlFor={`${uid}-expl`}>Explanation (shown after answering)</label>
        <textarea
          id={`${uid}-expl`}
          value={draft.explanation}
          onChange={(e) => set({ explanation: e.target.value })}
        />
      </div>

      <label className="row">
        <input
          type="checkbox"
          checked={draft.approve}
          onChange={(e) => set({ approve: e.target.checked })}
        />
        I have checked that the answer is correct
      </label>

      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
