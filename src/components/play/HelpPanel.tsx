"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { ApiClientError, apiFetch, errorMessage } from "@/lib/client/api";
import type { AiStatus, HelpAction, HelpResult } from "@/lib/client/types";
import { AI_DECLINED_MESSAGE, useAiConsent } from "../AiConsent";
import { Alert } from "../ui/Alert";
import { HelpStreamError, readHelpStream } from "./help-stream";

const ACTIONS: { action: HelpAction; label: string; hint: string }[] = [
  { action: "small_hint", label: "Small hint", hint: "A nudge, without the answer" },
  { action: "explain_step", label: "Explain the next step", hint: "What to do next" },
  { action: "why_wrong", label: "Why was I wrong?", hint: "After a wrong answer" },
  { action: "similar_example", label: "Show a similar example", hint: "A different, worked case" },
  { action: "full_explanation", label: "Full explanation", hint: "Includes the answer" },
];

/** While a retry is pending the answer is still hidden, so only these are on offer. */
const RETRY_ACTIONS = new Set<HelpAction>(["small_hint", "why_wrong"]);

const NARROW_QUERY = "(max-width: 900px)";

function subscribeNarrow(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** True on a narrow screen, where help is a drawer instead of a column beside the question. */
function useIsNarrow() {
  return useSyncExternalStore(
    subscribeNarrow,
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(NARROW_QUERY).matches
        : false,
    () => false,
  );
}

type Shown =
  | { status: "idle" }
  | { status: "loading"; action: HelpAction; partial: string }
  | { status: "done"; help: HelpResult }
  | { status: "error"; action: HelpAction; message: string; declined?: boolean };

const ERROR_TEXT: Record<string, string> = {
  stale_turn: "You have moved on to another question. Reload the page to continue.",
  no_wrong_answer:
    "You have not answered this question wrongly yet, so there is nothing to explain.",
  help_not_available_yet:
    "Only a small hint or help with your mistake is available until you have tried again.",
  help_disabled_in_exam: "Help is turned off in exam practice.",
};

/** The error code of a failed help response, read from a copy so the body stays usable. */
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

function AiNote({ status }: { status: AiStatus | null }) {
  if (!status || status.state === "available") return null;
  return (
    <p className="small muted" role="status">
      {status.state === "paused"
        ? "AI help is paused for now. Reviewed hints may still be available, and you can keep answering."
        : "AI help is off on this server. Reviewed hints may still be available, and you can keep answering."}
    </p>
  );
}

function Citation({ citation }: { citation: HelpResult["citations"][number] }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function open() {
    setError(null);
    try {
      // The passage is read through the authenticated route the server gave, never rebuilt here.
      const { segment } = await apiFetch<{ segment: { text: string } }>(citation.href);
      setText(segment.text);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <li className="small">
      {citation.filename}, {citation.location}{" "}
      {text === null ? (
        <button type="button" className="btn btn-small btn-quiet" onClick={open}>
          Show passage
        </button>
      ) : null}
      {error ? <span role="alert"> {error}</span> : null}
      {text !== null ? <blockquote>{text}</blockquote> : null}
    </li>
  );
}

function HelpAnswer({ help }: { help: HelpResult }) {
  return (
    <div className="stack-sm" aria-live="polite">
      <p className="row small">
        <span className={`badge ${help.origin === "ai_proposed" ? "badge-warn" : ""}`}>
          {help.origin === "approved" ? "Reviewed hint" : "AI-generated, may be wrong"}
        </span>
        {help.servedAs === "fallback_hint" ? (
          <span className="badge">A general hint: tailored help was not available</span>
        ) : null}
      </p>
      <p style={{ whiteSpace: "pre-wrap" }}>{help.text}</p>
      {help.uncertainty ? <p className="small muted">Not sure about: {help.uncertainty}</p> : null}
      {help.citations.length > 0 ? (
        <div>
          <p className="small">
            <strong>{help.sourceSupported ? "From your notes" : "Sources"}</strong>
          </p>
          <ul className="list">
            {help.citations.map((c) => (
              <Citation key={c.segmentId} citation={c} />
            ))}
          </ul>
        </div>
      ) : help.origin === "ai_proposed" ? (
        <p className="small muted">Not backed by a passage from your notes.</p>
      ) : null}
      <p className="small muted">
        This help is recorded, so an answer you give next counts as one made with help.
      </p>
    </div>
  );
}

type Consent = Pick<ReturnType<typeof useAiConsent>, "ensureConsent" | "explain">;

type BodyProps = {
  sessionId: string;
  questionId: string;
  pass: 1 | 2;
  canAsk: boolean;
  aiStatus: AiStatus | null;
};

function HelpBody({
  sessionId,
  questionId,
  pass,
  canAsk,
  aiStatus,
  consent,
}: BodyProps & { consent: Consent }) {
  const [shown, setShown] = useState<Shown>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const requestId = useRef(0);

  // Leaving the question (or the screen) cancels a request still in flight.
  useEffect(() => () => controller.current?.abort(), []);

  async function ask(action: HelpAction) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const id = ++requestId.current;
    const current = () => id === requestId.current && !abort.signal.aborted;
    setShown({ status: "loading", action, partial: "" });
    try {
      const send = () =>
        fetch(`/api/sessions/${sessionId}/help`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ questionId, action }),
          signal: abort.signal,
          credentials: "same-origin",
        });
      let response = await send();
      // A reviewed hint needs no consent, but a request that would call the model does. The server
      // refuses before using any quota or the model; show the notice, then ask once more.
      if (response.status === 403 && (await errorCode(response)) === "consent_required") {
        // Forget what this tab thought it knew, then ask (a no-op if it is accepted after all).
        consent.explain(new ApiClientError(403, "consent_required", ""));
        if (!(await consent.ensureConsent())) {
          if (current())
            setShown({ status: "error", action, message: AI_DECLINED_MESSAGE, declined: true });
          return;
        }
        if (!current()) return;
        response = await send();
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        const code = body?.error?.code ?? "error";
        if (current()) {
          setShown({
            status: "error",
            action,
            message:
              ERROR_TEXT[code] ?? body?.error?.message ?? "Help could not be loaded. Try again.",
          });
        }
        return;
      }
      let help: HelpResult;
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        help = await readHelpStream(response, (chunk) => {
          if (current()) {
            setShown((s) => (s.status === "loading" ? { ...s, partial: s.partial + chunk } : s));
          }
        });
      } else {
        help = ((await response.json()) as { help: HelpResult }).help;
      }
      // Only the final record counts as saved help, and only if this request is still the latest.
      if (current()) setShown({ status: "done", help });
    } catch (error) {
      if (!current()) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShown({
        status: "error",
        action,
        message:
          error instanceof HelpStreamError
            ? error.message
            : "Could not reach the server. Check your connection and try again.",
      });
    }
  }

  const loading = shown.status === "loading";
  const offered = pass === 2 ? ACTIONS.filter((a) => RETRY_ACTIONS.has(a.action)) : ACTIONS;

  return (
    <div className="stack-sm">
      <AiNote status={aiStatus} />
      {pass === 2 ? (
        <p className="small muted">
          This is your second try, so only a small hint or help with your mistake is available.
        </p>
      ) : null}
      <ul className="list help-actions" aria-label="Kinds of help">
        {offered.map((a) => (
          <li key={a.action}>
            <button
              type="button"
              className="btn btn-small"
              disabled={!canAsk || loading}
              onClick={() => void ask(a.action)}
            >
              {a.label}
            </button>{" "}
            <span className="small muted">{a.hint}</span>
          </li>
        ))}
      </ul>
      {!canAsk ? (
        <p className="small muted">Help is for the question you are answering now.</p>
      ) : null}

      {shown.status === "loading" ? (
        <div aria-live="polite" aria-busy="true">
          <p className="small muted">Getting help…</p>
          {shown.partial ? (
            <p className="muted" style={{ whiteSpace: "pre-wrap" }}>
              {shown.partial}
            </p>
          ) : null}
        </div>
      ) : null}
      {shown.status === "error" ? (
        <div className="stack-sm">
          <Alert tone="error">{shown.message}</Alert>
          <div>
            <button type="button" className="btn btn-small" onClick={() => void ask(shown.action)}>
              Try again
            </button>
          </div>
        </div>
      ) : null}
      {shown.status === "done" ? <HelpAnswer help={shown.help} /> : null}
    </div>
  );
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => !el.hasAttribute("disabled"));
}

/** A bottom drawer: labelled, closes on Escape, keeps Tab inside, and returns focus on close. */
function Drawer({
  titleId,
  opener,
  open,
  onClose,
  children,
}: {
  titleId: string;
  opener: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  // Focus moves into the drawer when it opens and back to the button when it closes. The drawer
  // stays mounted while closed, so help already loaded is still there when it is reopened.
  useEffect(() => {
    if (open) {
      root.current?.querySelector<HTMLElement>("[data-drawer-close]")?.focus();
    } else if (wasOpen.current) {
      opener.current?.focus();
    }
    wasOpen.current = open;
  }, [open, opener]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !root.current) return;
    const items = focusables(root.current);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="help-drawer"
      hidden={!open}
      onKeyDown={onKeyDown}
    >
      <div className="row row-between">
        <h2 id={titleId} className="small">
          Help with this question
        </h2>
        <button type="button" className="btn btn-small" data-drawer-close onClick={onClose}>
          Close help
        </button>
      </div>
      {children}
    </div>
  );
}

type Props = BodyProps;

/**
 * Help beside the question on wide screens, and a drawer on narrow ones. The page remounts it
 * for every question and pass, so one question's help never shows on the next. The browser sends
 * only the question and the kind of help; the server decides the turn and what may be said.
 */
export function HelpPanel(props: Props) {
  const { ensureConsent, explain, dialog } = useAiConsent();
  const consent = { ensureConsent, explain };
  const narrow = useIsNarrow();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  if (!narrow) {
    return (
      <aside className="card help-panel" aria-labelledby={titleId}>
        <h2 id={titleId} className="small">
          Help with this question
        </h2>
        <HelpBody {...props} consent={consent} />
        {dialog}
      </aside>
    );
  }
  return (
    <div className="help-launch">
      <button
        ref={opener}
        type="button"
        className="btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Get help
      </button>
      <Drawer titleId={titleId} opener={opener} open={open} onClose={() => setOpen(false)}>
        <HelpBody {...props} consent={consent} />
      </Drawer>
      {/* Outside the drawer, so the notice and the drawer never fight over Tab and Escape. */}
      {dialog}
      {/* Room to scroll the question (and its image) above the open drawer, never under it. */}
      {open ? <div aria-hidden="true" className="help-drawer-space" /> : null}
    </div>
  );
}
