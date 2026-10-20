import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="auth-page">
      <p className="brand brand-large">Quizzz</p>
      {children}
    </main>
  );
}
