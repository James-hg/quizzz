import { FormEvent, useMemo, useState } from "react";
import { apiRequest } from "../apiClient";

export type BootstrapUser = {
    id: string;
    email: string;
    display_name: string | null;
    is_admin: boolean;
    created_at: string;
};

export type BootstrapFolder = {
    id: string;
    owner_id: string;
    parent_id: string | null;
    name: string;
    color: string;
    created_at: string;
    updated_at: string;
};

export type BootstrapOption = {
    id: string;
    text: string;
    is_correct: boolean;
    position: number;
};

export type BootstrapQuestion = {
    id: string;
    text: string;
    position: number;
    options: BootstrapOption[];
};

export type BootstrapQuiz = {
    id: string;
    title: string;
    subject: string | null;
    folder_id: string | null;
    questions: BootstrapQuestion[];
};

export type BootstrapStatus = {
    quiz_id: string;
    active_session_id: string | null;
    current_index: number;
    is_paused: boolean;
    elapsed_seconds: number;
    last_completed_at: string | null;
    last_score_correct: number;
    last_score_total: number;
};

export type BootstrapPayload = {
    user: BootstrapUser;
    folders: BootstrapFolder[];
    quizzes: BootstrapQuiz[];
    statuses: BootstrapStatus[];
};

export type AuthResponse = {
    access_token: string;
    token_type: string;
    data: BootstrapPayload;
};

type Mode = "login" | "signup";

type Props = {
    mode: Mode;
    onModeChange: (mode: Mode) => void;
    onSuccess: (result: AuthResponse) => void;
};

export function AuthPage({ mode, onModeChange, onSuccess }: Props) {
    const [displayName, setDisplayName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const title = useMemo(() => {
        return mode === "login" ? "Welcome back" : "Create your account";
    }, [mode]);

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();
        setError(null);

        const trimmedEmail = email.trim();
        if (!trimmedEmail) {
            setError("Email is required.");
            return;
        }

        if (password.length < 8) {
            setError("Password must be at least 8 characters.");
            return;
        }

        if (mode === "signup" && password !== confirmPassword) {
            setError("Password confirmation does not match.");
            return;
        }

        setLoading(true);
        try {
            const endpoint = mode === "login" ? "/auth/login" : "/auth/signup";
            const payload =
                mode === "login"
                    ? {
                          email: trimmedEmail,
                          password,
                      }
                    : {
                          display_name: displayName.trim() || null,
                          email: trimmedEmail,
                          password,
                      };

            const result = await apiRequest<AuthResponse>(endpoint, {
                method: "POST",
                body: JSON.stringify(payload),
            });
            onSuccess(result);
        } catch (err) {
            if (err instanceof Error) {
                setError(err.message);
            } else {
                setError("Authentication failed.");
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="auth-shell">
            <div className="auth-card">
                <div className="eyebrow">Quizzz</div>
                <h1>{title}</h1>
                <p className="muted auth-subtitle">
                    {mode === "login"
                        ? "Sign in to continue your quizzes and folders."
                        : "Sign up to sync your quizzes and folders in PostgreSQL."}
                </p>

                <div className="auth-tabs">
                    <button
                        className={`chip ${mode === "login" ? "active" : ""}`}
                        onClick={() => onModeChange("login")}
                        type="button"
                    >
                        Login
                    </button>
                    <button
                        className={`chip ${mode === "signup" ? "active" : ""}`}
                        onClick={() => onModeChange("signup")}
                        type="button"
                    >
                        Sign up
                    </button>
                </div>

                <form className="auth-form" onSubmit={handleSubmit}>
                    {mode === "signup" && (
                        <label className="auth-field">
                            <span>Display name</span>
                            <input
                                value={displayName}
                                onChange={(e) => setDisplayName(e.target.value)}
                                placeholder="Jane Doe"
                                autoComplete="name"
                            />
                        </label>
                    )}

                    <label className="auth-field">
                        <span>Email</span>
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="you@example.com"
                            autoComplete="email"
                            required
                        />
                    </label>

                    <label className="auth-field">
                        <span>Password</span>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="At least 8 characters"
                            autoComplete={mode === "login" ? "current-password" : "new-password"}
                            required
                        />
                    </label>

                    {mode === "signup" && (
                        <label className="auth-field">
                            <span>Confirm password</span>
                            <input
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                placeholder="Repeat password"
                                autoComplete="new-password"
                                required
                            />
                        </label>
                    )}

                    {error && <div className="error-text">{error}</div>}

                    <button className="btn primary auth-submit" type="submit" disabled={loading}>
                        {loading
                            ? mode === "login"
                                ? "Signing in..."
                                : "Creating account..."
                            : mode === "login"
                              ? "Login"
                              : "Create account"}
                    </button>
                </form>
            </div>
        </div>
    );
}
