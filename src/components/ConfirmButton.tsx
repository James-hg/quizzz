"use client";

import { useState } from "react";

type Props = {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  className?: string;
};

/** Two-step button for destructive actions; no browser dialogs, fully keyboard accessible. */
export function ConfirmButton({
  label,
  confirmLabel = "Yes, delete",
  onConfirm,
  disabled,
  className,
}: Props) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        className={className ?? "btn btn-danger btn-small"}
        onClick={() => setAsking(true)}
        disabled={disabled}
      >
        {label}
      </button>
    );
  }
  return (
    <span className="row" role="group" aria-label={`Confirm: ${label}`}>
      <button
        type="button"
        className="btn btn-danger btn-small"
        onClick={async () => {
          setAsking(false);
          await onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="btn btn-small" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
