"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth-rules";
import { authClient } from "@/lib/client/auth-client";
import { Alert } from "./ui/Alert";
import { Field } from "./ui/Field";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const signUp = mode === "sign-up";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    // Passwords are sent exactly as typed: no trimming.
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim();
    setPending(true);
    try {
      const result = signUp
        ? await authClient.signUp.email({ email, password, name: name || email })
        : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? "That did not work. Check your details and try again.");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card auth-card" onSubmit={onSubmit} noValidate>
      <h1>{signUp ? "Create your account" : "Sign in"}</h1>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {signUp ? <Field label="Name" name="name" autoComplete="name" required /> : null}
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete={signUp ? "new-password" : "current-password"}
        required
        minLength={signUp ? PASSWORD_MIN_LENGTH : undefined}
        maxLength={PASSWORD_MAX_LENGTH}
        hint={signUp ? `At least ${PASSWORD_MIN_LENGTH} characters. Spaces count.` : undefined}
      />
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Please wait…" : signUp ? "Create account" : "Sign in"}
      </button>
      <p className="auth-switch">
        {signUp ? (
          <>
            Already have an account? <Link href="/sign-in">Sign in</Link>
          </>
        ) : (
          <>
            New here? <Link href="/sign-up">Create an account</Link>
          </>
        )}
      </p>
    </form>
  );
}
