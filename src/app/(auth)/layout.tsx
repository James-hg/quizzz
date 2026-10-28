import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { isAuthDisabled } from "@/server/auth/local-user";

export default function AuthLayout({ children }: { children: ReactNode }) {
  // With login off there is nothing to sign in to: go straight to the app.
  if (isAuthDisabled()) redirect("/");
  return (
    <main id="main" className="auth-page">
      <p className="brand brand-large">Quizzz</p>
      {children}
    </main>
  );
}
