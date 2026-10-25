"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiClientError, apiFetch, errorMessage } from "@/lib/client/api";
import { countsFromDetails, type PlayabilityCounts } from "@/lib/playability";
import { PracticeBlockedNotice } from "./PracticeBlockedNotice";
import { Alert } from "./ui/Alert";

type Props = { questionSetId: string; disabled?: boolean; label?: string };

/** Starts the set's quiz session, or resumes the one already in progress. */
export function StartPracticeButton({ questionSetId, disabled, label = "Practice" }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<PlayabilityCounts | null>(null);
  const [pending, setPending] = useState(false);

  async function start() {
    setError(null);
    setBlocked(null);
    setPending(true);
    try {
      const { session } = await apiFetch<{ session: { id: string } }>("/api/sessions", {
        body: { questionSetId, mode: "quiz" },
      });
      router.push(`/question-sets/${questionSetId}/play/${session.id}`);
    } catch (e) {
      // The server says why nothing can be practised; show that instead of a generic error.
      const counts =
        e instanceof ApiClientError && e.code === "no_playable_questions"
          ? countsFromDetails(e.details)
          : null;
      if (counts) setBlocked(counts);
      else setError(errorMessage(e));
      setPending(false);
    }
  }

  return (
    <span>
      <button
        type="button"
        className="btn btn-primary"
        onClick={start}
        disabled={disabled || pending}
      >
        {pending ? "Starting…" : label}
      </button>
      {blocked ? <PracticeBlockedNotice questionSetId={questionSetId} counts={blocked} /> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
    </span>
  );
}
