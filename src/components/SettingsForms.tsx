"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth-rules";
import { apiFetch, errorMessage } from "@/lib/client/api";
import { authClient } from "@/lib/client/auth-client";
import { Alert } from "./ui/Alert";
import { Field } from "./ui/Field";

type Profile = { email: string; displayName: string; timezone: string };

export function ProfileForm({ profile, timezones }: { profile: Profile; timezones: string[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const form = new FormData(event.currentTarget);
    const displayName = String(form.get("displayName") ?? "").trim();
    setPending(true);
    try {
      await apiFetch("/api/me", {
        method: "PATCH",
        body: {
          ...(displayName ? { displayName } : {}),
          email: String(form.get("email") ?? "").trim(),
          timezone: String(form.get("timezone") ?? ""),
        },
      });
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={onSubmit}>
      <h2>Profile</h2>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}
      <Field
        label="Display name"
        name="displayName"
        defaultValue={profile.displayName}
        maxLength={80}
      />
      <Field
        label="Email"
        name="email"
        type="email"
        defaultValue={profile.email}
        required
        autoComplete="email"
      />
      <div className="field">
        <label htmlFor="timezone">Timezone</label>
        <select id="timezone" name="timezone" defaultValue={profile.timezone}>
          {timezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
        <p className="hint">Used to decide what “today” means for your study sessions.</p>
      </div>
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}

export function PasswordForm() {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setDone(false);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    // Passwords are sent exactly as typed; spaces are part of the password.
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    if (newPassword !== String(form.get("confirmPassword") ?? "")) {
      setError("The new passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) {
        setError(result.error.message ?? "Could not change the password.");
        return;
      }
      setDone(true);
      formElement.reset();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={onSubmit}>
      <h2>Password</h2>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {done ? <Alert tone="success">Password changed. Other devices were signed out.</Alert> : null}
      <Field
        label="Current password"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
      />
      <Field
        label="New password"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
      />
      <Field
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        required
      />
      <div>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Changing…" : "Change password"}
        </button>
      </div>
    </form>
  );
}
