"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/client/api";
import { Alert } from "./ui/Alert";

type Props = { questionSetId: string; disabled?: boolean; label?: string };

/** Starts the set's quiz session, or resumes the one already in progress. */
export function StartPracticeButton({ questionSetId, disabled, label = "Practice" }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function start() {
    setError(null);
    setPending(true);
    try {
      const { session } = await apiFetch<{ session: { id: string } }>("/api/sessions", {
        body: { questionSetId, mode: "quiz" },
      });
      router.push(`/question-sets/${questionSetId}/play/${session.id}`);
    } catch (e) {
      setError(errorMessage(e));
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
      {error ? <Alert tone="error">{error}</Alert> : null}
    </span>
  );
}
