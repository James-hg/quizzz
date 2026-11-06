"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AiConsentStatus } from "@/lib/ai-consent";
import { ApiClientError, apiFetch, errorMessage } from "@/lib/client/api";
import { Alert } from "./ui/Alert";

/**
 * Notice version this browser tab has seen accepted. Only a shortcut to skip a request: the server
 * checks consent on every AI call, and clears this when it says `consent_required`.
 */
let knownAccepted: string | null = null;

/** Message for an AI action the user declined at the notice. */
export const AI_DECLINED_MESSAGE =
  "AI help stays off until you accept the AI data notice. Everything else still works.";

const STALE_MESSAGE = "The AI data notice changed. Accept the new notice, then try again.";

/** For tests: forget what this tab knew. */
export function resetAiConsentCache() {
  knownAccepted = null;
}

type Dialog = {
  status: AiConsentStatus;
  resolve: (accepted: boolean) => void;
};

/**
 * Asks for consent before the first AI action. Call `ensureConsent()` right before a model request
 * and run the request only when it resolves true. Render `dialog` once in the component.
 * `explain(error)` turns a failed request into a message, and also makes the next action ask
 * again when the server reports that the notice changed.
 */
export function useAiConsent() {
  const [open, setOpen] = useState<Dialog | null>(null);
  const openRef = useRef<Dialog | null>(null);

  const ensureConsent = useCallback(async (): Promise<boolean> => {
    if (knownAccepted !== null) return true;
    const status = await apiFetch<AiConsentStatus>("/api/ai/consent");
    if (status.accepted) {
      knownAccepted = status.noticeVersion;
      return true;
    }
    if (openRef.current) return false; // already asking
    return new Promise<boolean>((resolve) => {
      const dialog: Dialog = {
        status,
        resolve: (accepted) => {
          openRef.current = null;
          setOpen(null);
          resolve(accepted);
        },
      };
      openRef.current = dialog;
      setOpen(dialog);
    });
  }, []);

  const explain = useCallback((error: unknown): string => {
    if (error instanceof ApiClientError && error.code === "consent_required") {
      knownAccepted = null;
      return STALE_MESSAGE;
    }
    return errorMessage(error);
  }, []);

  const dialog = open ? <ConsentDialog key={open.status.noticeVersion} {...open} /> : null;
  return { ensureConsent, explain, dialog };
}

function ConsentDialog({ status: initial, resolve }: Dialog) {
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    returnTo.current = document.activeElement;
    panel.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      if (returnTo.current instanceof HTMLElement) returnTo.current.focus();
    };
  }, []);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<AiConsentStatus>("/api/ai/consent", {
        body: { noticeVersion: status.noticeVersion, accepted: true },
      });
      knownAccepted = result.noticeVersion;
      resolve(true);
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "notice_version_changed") {
        // Show the new wording and make the user accept that, not the old one.
        try {
          setStatus(await apiFetch<AiConsentStatus>("/api/ai/consent"));
          setError("The notice changed while this was open. Please read it again.");
        } catch (inner) {
          setError(errorMessage(inner));
        }
      } else {
        setError(errorMessage(e));
      }
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !busy) {
      event.stopPropagation();
      resolve(false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      panel.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? [],
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const { notice } = status;
  return (
    <div className="modal-backdrop">
      <div
        ref={panel}
        className="modal card stack-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-consent-title"
        onKeyDown={onKeyDown}
      >
        <h2 id="ai-consent-title">{notice.title}</h2>
        {notice.paragraphs.map((p) => (
          <p key={p}>{p}</p>
        ))}
        <p>
          <a href={notice.termsUrl} target="_blank" rel="noopener noreferrer">
            {notice.termsLabel}
          </a>
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={accept}
            disabled={busy}
            data-initial-focus
          >
            {busy ? "Saving…" : "Accept and continue"}
          </button>
          <button type="button" className="btn" onClick={() => resolve(false)} disabled={busy}>
            No thanks, keep studying without AI
          </button>
        </div>
      </div>
    </div>
  );
}
