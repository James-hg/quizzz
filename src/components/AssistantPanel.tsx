"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch, errorMessage } from "@/lib/client/api";
import { Alert } from "./ui/Alert";

type Proposal = {
  type: "mcq_single";
  prompt: string;
  options: { id: string; text: string }[];
  correctOptionIds: string[];
  explanation?: string | null;
};

type Turn = { role: "user" | "assistant"; content: string };

type Props = { enabled: boolean; questionSetId: string; courseId: string; setTitle: string };

/**
 * Optional AI help. Everything it produces is a proposal: generated questions are saved as
 * excluded, unreviewed drafts. With AI turned off the rest of the app is unaffected.
 */
export function AssistantPanel({ enabled, questionSetId, courseId, setTitle }: Props) {
  const router = useRouter();
  const [history, setHistory] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [suggested, setSuggested] = useState<string | null>(null);
  const [busy, setBusy] = useState<"chat" | "generate" | "save" | "title" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!enabled) {
    return (
      <section className="card" aria-labelledby="ai-heading">
        <h2 id="ai-heading">AI assistant</h2>
        <Alert tone="info">
          AI help is turned off on this server. Practice, importing, and editing all work without
          it.
        </Alert>
      </section>
    );
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

  async function ask(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text) return;
    const reply = await guarded("chat", () =>
      apiFetch<{ reply: string }>("/api/ai/chat", {
        body: { message: text, history: history.slice(-10), questionSetId, courseId },
      }),
    );
    if (reply) {
      const turns: Turn[] = [
        { role: "user", content: text },
        { role: "assistant", content: reply.reply },
      ];
      setHistory((h) => [...h, ...turns].slice(-10));
      setMessage("");
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

  return (
    <section className="card stack" aria-labelledby="ai-heading">
      <h2 id="ai-heading">AI assistant</h2>
      <p className="hint">
        Suggestions are proposals, not facts. Check them before trusting them. Your text is sent to
        the AI provider to answer.
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <form onSubmit={ask} className="form-grid">
        <h3>Ask a question</h3>
        {history.length > 0 ? (
          <ul className="list" aria-label="Conversation" aria-live="polite">
            {history.map((turn, i) => (
              <li key={i}>
                <strong>{turn.role === "user" ? "You" : "Assistant"}:</strong>{" "}
                <span style={{ whiteSpace: "pre-wrap" }}>{turn.content}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="field">
          <label htmlFor="ai-message">Your question</label>
          <textarea
            id="ai-message"
            value={message}
            maxLength={2000}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
        <div>
          <button type="submit" className="btn" disabled={busy !== null || !message.trim()}>
            {busy === "chat" ? "Thinking…" : "Ask"}
          </button>
        </div>
      </form>

      <form onSubmit={generate} className="form-grid">
        <h3>Propose practice questions</h3>
        <div className="row">
          <div className="field">
            <label htmlFor="ai-count">How many</label>
            <input id="ai-count" name="count" type="number" min={1} max={10} defaultValue={5} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="ai-topic">Topic (optional)</label>
            <input id="ai-topic" name="topic" type="text" maxLength={200} placeholder={setTitle} />
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
    </section>
  );
}
