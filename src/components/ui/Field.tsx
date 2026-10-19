import { useId, type InputHTMLAttributes, type ReactNode } from "react";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: ReactNode;
};

export function Field({ label, error, hint, id, ...input }: Props) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = [error ? `${inputId}-error` : "", hint ? `${inputId}-hint` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
      {hint ? (
        <p className="hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${inputId}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
