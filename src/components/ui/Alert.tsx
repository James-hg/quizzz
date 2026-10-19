import type { ReactNode } from "react";

type Props = { tone?: "error" | "info" | "success" | "warning"; children: ReactNode };

/** Errors are announced to assistive tech; other tones are plain text blocks. */
export function Alert({ tone = "info", children }: Props) {
  return (
    <div className={`alert alert-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}
