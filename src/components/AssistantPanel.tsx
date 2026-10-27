"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import {
  afterEffect,
  COMMAND_EXAMPLES,
  optionId,
  previewOf,
  START,
  step,
  type CommandQuestion,
  type Effect,
  type FlowContext,
  type FlowResult,
  type Outcome,
  type Pending,
} from "@/lib/ai/command-flow";
import { ApiClientError, apiFetch, errorMessage } from "@/lib/client/api";
import type { OwnerQuestionView } from "@/lib/client/types";
import { classifyQuestion } from "@/lib/playability";
import { Alert } from "./ui/Alert";

type Proposal = {
  type: "mcq_single";
  prompt: string;
  options: { id: string; text: string }[];
  correctOptionIds: string[];
  explanation?: string | null;
};

type Turn = { role: "user" | "assistant"; content: string };

type Props = {
  enabled: boolean;
  questionSetId: string;
  courseId: string;
  setTitle: string;
  questions: OwnerQuestionView[];
};

function toCommandQuestion(q: OwnerQuestionView): CommandQuestion {
  const correct = q.answerKey.kind === "options" ? q.answerKey.correctOptionIds : [];
  return {
    id: q.id,
    text: q.prompt,
    type: q.type,
    needsReview:
      classifyQuestion({
        status: q.status,
        evidenceStatus: q.evidenceStatus,
        answerKind: q.answerKey.kind,
      }) === "needs_review",
    options: q.options.map((o) => ({ id: o.id, text: o.text, correct: correct.includes(o.id) })),
  };
}

/**
 * Editor assistant. Edit commands ("rename this set", "remove question 3", "shuffle the
 * choices"...) work with or without AI: each shows a preview and waits for a confirmation, then
 * goes through the same API as the editor, so every change is an ordinary revisioned edit.
 * Questions the commands do not cover go to the AI chat when it is on. Everything the AI
 * produces is a proposal: generated questions are saved as excluded, unreviewed drafts.
 */
export function AssistantPanel({ enabled, questionSetId, courseId, setTitle, questions }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(START);
  const [transcript, setTranscript] = useState<Turn[]>([]);
  const [chatHistory, setChatHistory] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [suggested, setSuggested] = useState<string | null>(null);
  const [busy, setBusy] = useState<"command" | "chat" | "generate" | "save" | "title" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const ctx: FlowContext = useMemo(
    () => ({ questions: questions.map(toCommandQuestion), setTitle, aiEnabled: enabled }),
    [questions, setTitle, enabled],
  );

  function say(...messages: string[]) {
    if (messages.length === 0) return;
    setTranscript((t) => [
      ...t,
      ...messages.map((content) => ({ role: "assistant" as const, content })),
    ]);
  }

  async function guarded<T>(
    kind: NonNullable<typeof busy>,
    work: () => Promise<T>,
  ): Promise<T | undefined> {
    setError(null);
    setNotice(null);
    setBusy(kind);
    try {
      return await work();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  // ----- commands ---------------------------------------------------------------------------

  async function runEffect(effect: Effect): Promise<Outcome> {
    try {
      switch (effect.type) {
        case "rename_set":
          await apiFetch(`/api/question-sets/${questionSetId}`, {
            method: "PATCH",
            body: { title: effect.title },
          });
          return { ok: true };
        case "create_set": {
          const created = await apiFetch<{ questionSet: { id: string } }>(
            `/api/courses/${courseId}/question-sets`,
            { body: { title: effect.title } },
          );
          return { ok: true, data: { id: created.questionSet.id } };
        }
        case "reorder":
          await apiFetch(`/api/question-sets/${questionSetId}/questions/order`, {
            method: "PUT",
            body: { questionIds: effect.questionIds },
          });
          return { ok: true };
        case "shuffle_choices": {
          let done = 0;
          let failed = 0;
          for (const id of effect.questionIds) {
            try {
              await apiFetch(`/api/questions/${id}/shuffle-options`, { method: "POST" });
              done += 1;
            } catch {
              failed += 1;
            }
          }
          return done > 0 || failed === 0
            ? { ok: true, data: { done, failed } }
            : { ok: false, code: "shuffle_failed", message: "No question could be shuffled." };
        }
        case "add_question":
          await apiFetch(`/api/question-sets/${questionSetId}/questions`, {
            body: {
              type: "mcq_single",
              prompt: effect.prompt,
              options: effect.options.map((text, i) => ({ id: optionId(i), text })),
              correctOptionIds: [optionId(effect.correctIndex)],
            },
          });
          return { ok: true };
        case "update_question":
          await apiFetch(`/api/questions/${effect.questionId}`, {
            method: "PATCH",
            body: effect.patch,
          });
          return { ok: true };
        case "delete_question":
          await apiFetch(`/api/questions/${effect.questionId}`, { method: "DELETE" });
          return { ok: true };
        case "exclude_question":
          await apiFetch(`/api/questions/${effect.questionId}/exclude`, { method: "POST" });
          return { ok: true };
        case "suggest_title": {
          const result = await apiFetch<{ title: string }>(
            `/api/ai/question-sets/${questionSetId}/suggest-title`,
            { method: "POST" },
          );
          return { ok: true, data: { title: result.title } };
        }
        case "generate": {
          const result = await apiFetch<{ proposals: Proposal[]; dropped: number }>(
            `/api/ai/question-sets/${questionSetId}/generate-questions`,
            { body: { count: effect.count, ...(effect.topic ? { topic: effect.topic } : {}) } },
          );
          return {
            ok: true,
            data: {
              proposed: result.proposals.length,
              dropped: result.dropped,
              proposals: result.proposals,
            },
          };
        }
      }
    } catch (e) {
      if (e instanceof ApiClientError) return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: "error", message: errorMessage(e) };
    }
  }

  async function execute(effect: Effect) {
    setBusy("command");
    const outcome = await runEffect(effect);
    const follow = afterEffect(effect, outcome, ctx);
    setPending(follow.state);
    say(...follow.messages);
    setBusy(null);

    if (!outcome.ok) return;
    if (effect.type === "create_set") {
      router.push(`/question-sets/${(outcome.data as { id: string }).id}/edit`);
      return;
    }
    if (effect.type === "generate") {
      const found = (outcome.data as { proposals: Proposal[] }).proposals;
      setProposals(found);
      setPicked(new Set(found.map((_, i) => i)));
      return;
    }
    if (effect.type !== "suggest_title") router.refresh();
  }

  async function apply(result: FlowResult, original: string) {
    setPending(result.state);
    say(...result.messages);
    if (result.run) await execute(result.run);
    else if (result.passToAi) await askAi(original);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || busy) return;
    setError(null);
    setNotice(null);
    setMessage("");
    setTranscript((t) => [...t, { role: "user", content: text }]);
    await apply(step(pending, text, ctx), text);
  }

  async function answerPending(text: "yes" | "cancel") {
    if (busy) return;
    setTranscript((t) => [...t, { role: "user", content: text === "yes" ? "Confirm" : "Cancel" }]);
    await apply(step(pending, text, ctx), text);
  }

  // ----- AI chat and proposals --------------------------------------------------------------

  async function askAi(text: string) {
    setBusy("chat");
    try {
      const reply = await apiFetch<{ reply: string }>("/api/ai/chat", {
        body: { message: text, history: chatHistory.slice(-10), questionSetId, courseId },
      });
      say(reply.reply);
      setChatHistory((h) =>
        [
          ...h,
          { role: "user" as const, content: text },
          { role: "assistant" as const, content: reply.reply },
        ].slice(-10),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const topic = String(form.get("topic") ?? "").trim();
    const count = Number(form.get("count") ?? 5);
    const result = await guarded("generate", () =>
      apiFetch<{ proposals: Proposal[]; dropped: number }>(
        `/api/ai/question-sets/${questionSetId}/generate-questions`,
        { body: { count, ...(topic ? { topic } : {}) } },
      ),
    );
    if (result) {
      setProposals(result.proposals);
      setPicked(new Set(result.proposals.map((_, i) => i)));
      if (result.proposals.length === 0)
        setNotice("No usable questions came back. Try again or change the topic.");
      else if (result.dropped > 0)
        setNotice(`${result.dropped} proposed questions failed checks and were left out.`);
    }
  }

  async function saveSelected() {
    const chosen = proposals.filter((_, i) => picked.has(i));
    if (chosen.length === 0) return;
    const saved = await guarded("save", () =>
      apiFetch<{ questions: unknown[] }>(`/api/ai/question-sets/${questionSetId}/save-proposals`, {
        body: { proposals: chosen },
      }),
    );
    if (saved) {
      setProposals([]);
      setNotice(
        `Saved ${chosen.length} as AI-proposed drafts. They are excluded from practice until you review and include them.`,
      );
      router.refresh();
    }
  }

  async function suggestTitle() {
    const result = await guarded("title", () =>
      apiFetch<{ title: string }>(`/api/ai/question-sets/${questionSetId}/suggest-title`, {
        method: "POST",
      }),
    );
    if (result) setSuggested(result.title);
  }

  async function applyTitle() {
    if (!suggested) return;
    const ok = await guarded("title", () =>
      apiFetch(`/api/question-sets/${questionSetId}`, {
        method: "PATCH",
        body: { title: suggested },
      }),
    );
    if (ok !== undefined) {
      setSuggested(null);
      router.refresh();
    }
  }

  const preview = previewOf(pending);

  return (
    <section className="card stack" aria-labelledby="ai-heading">
      <h2 id="ai-heading">Assistant</h2>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <form onSubmit={send} className="form-grid">
        <h3>{enabled ? "Ask or tell me what to change" : "Tell me what to change"}</h3>
        <p className="hint">
          Changes are shown first and only applied when you confirm. Try:{" "}
          {COMMAND_EXAMPLES.slice(0, 5).map((e, i) => (
            <span key={e}>
              {i > 0 ? ", " : ""}
              <q>{e}</q>
            </span>
          ))}
          .{" "}
          {enabled
            ? "Anything else is answered by the AI."
            : "AI help is turned off on this server, so I only understand these commands."}
        </p>
        {transcript.length > 0 ? (
          <ul className="list" aria-label="Conversation" aria-live="polite">
            {transcript.map((turn, i) => (
              <li key={i}>
                <strong>{turn.role === "user" ? "You" : "Assistant"}:</strong>{" "}
                <span style={{ whiteSpace: "pre-wrap" }}>{turn.content}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {pending.kind === "confirm" ? (
          <div role="group" aria-label="Change waiting for your confirmation" className="card">
            {preview.length > 0 ? (
              <ul className="small">
                {preview.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : null}
            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => answerPending("yes")}
                disabled={busy !== null}
              >
                Confirm
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => answerPending("cancel")}
                disabled={busy !== null}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="assistant-message">{enabled ? "Your message" : "Your command"}</label>
          <input
            id="assistant-message"
            type="text"
            value={message}
            maxLength={2000}
            autoComplete="off"
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
        <div>
          <button type="submit" className="btn" disabled={busy !== null || !message.trim()}>
            {busy === "chat" ? "Thinking…" : busy === "command" ? "Working…" : "Send"}
          </button>
        </div>
      </form>

      {!enabled ? (
        <Alert tone="info">
          AI help is turned off on this server. Practice, importing, and editing all work without
          it.
        </Alert>
      ) : (
        <>
          <p className="hint">
            Suggestions are proposals, not facts. Check them before trusting them. Your text is sent
            to the AI provider to answer.
          </p>

          <form onSubmit={generate} className="form-grid">
            <h3>Propose practice questions</h3>
            <div className="row">
              <div className="field">
                <label htmlFor="ai-count">How many</label>
                <input id="ai-count" name="count" type="number" min={1} max={10} defaultValue={5} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="ai-topic">Topic (optional)</label>
                <input
                  id="ai-topic"
                  name="topic"
                  type="text"
                  maxLength={200}
                  placeholder={setTitle}
                />
              </div>
            </div>
            <div>
              <button type="submit" className="btn" disabled={busy !== null}>
                {busy === "generate" ? "Writing…" : "Propose questions"}
              </button>
            </div>
          </form>

          {proposals.length > 0 ? (
            <div className="stack-sm">
              <h3>Proposed questions</h3>
              <ul className="list">
                {proposals.map((p, i) => (
                  <li key={i}>
                    <label className="row" style={{ alignItems: "flex-start" }}>
                      <input
                        type="checkbox"
                        checked={picked.has(i)}
                        onChange={() =>
                          setPicked((s) => {
                            const next = new Set(s);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          })
                        }
                        aria-label={`Keep proposed question ${i + 1}`}
                      />
                      <span>
                        <strong>{p.prompt}</strong>
                        <ul className="small">
                          {p.options.map((o) => (
                            <li key={o.id}>
                              {o.text}
                              {p.correctOptionIds.includes(o.id) ? " — proposed answer" : ""}
                            </li>
                          ))}
                        </ul>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn btn-primary"
                onClick={saveSelected}
                disabled={busy !== null || picked.size === 0}
              >
                {busy === "save" ? "Saving…" : `Save ${picked.size} as drafts`}
              </button>
            </div>
          ) : null}

          <div className="stack-sm">
            <h3>Suggest a title</h3>
            {suggested ? (
              <div className="row">
                <span>
                  <strong>{suggested}</strong>
                </span>
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  onClick={applyTitle}
                  disabled={busy !== null}
                >
                  Use this title
                </button>
                <button type="button" className="btn btn-small" onClick={() => setSuggested(null)}>
                  Dismiss
                </button>
              </div>
            ) : (
              <button type="button" className="btn" onClick={suggestTitle} disabled={busy !== null}>
                {busy === "title" ? "Thinking…" : "Suggest a title"}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
