import { FormEvent, useEffect, useState } from "react";

type User = {
    id: string;
    email: string;
    display_name: string | null;
    is_admin: boolean;
    created_at: string;
};

type Props = {
    user: User | null;
    onLogout: () => void;
    onUpdateProfile: (payload: {
        display_name?: string | null;
        email?: string;
    }) => Promise<User>;
    onChangePassword: (payload: {
        current_password: string;
        new_password: string;
    }) => Promise<void>;
};

export function SettingsPage({ user, onLogout, onUpdateProfile, onChangePassword }: Props) {
    const [displayName, setDisplayName] = useState(user?.display_name ?? "");
    const [email, setEmail] = useState(user?.email ?? "");
    const [profileSaving, setProfileSaving] = useState(false);
    const [passwordSaving, setPasswordSaving] = useState(false);
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setDisplayName(user?.display_name ?? "");
        setEmail(user?.email ?? "");
    }, [user]);

    const onProfileSubmit = async (event: FormEvent) => {
        event.preventDefault();
        setError(null);
        setMessage(null);

        if (!email.trim()) {
            setError("Email is required.");
            return;
        }

        setProfileSaving(true);
        try {
            await onUpdateProfile({
                email: email.trim(),
                display_name: displayName.trim() || null,
            });
            setMessage("Profile updated.");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update profile.");
        } finally {
            setProfileSaving(false);
        }
    };

    const onPasswordSubmit = async (event: FormEvent) => {
        event.preventDefault();
        setError(null);
        setMessage(null);

        if (newPassword.length < 8) {
            setError("New password must be at least 8 characters.");
            return;
        }
        if (newPassword !== confirmPassword) {
            setError("Password confirmation does not match.");
            return;
        }

        setPasswordSaving(true);
        try {
            await onChangePassword({
                current_password: currentPassword,
                new_password: newPassword,
            });
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
            setMessage("Password updated.");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to change password.");
        } finally {
            setPasswordSaving(false);
        }
    };

    return (
        <div className="page settings-layout">
            <main className="main">
                <header className="main-header">
                    <div>
                        <div className="eyebrow">Settings</div>
                        <h1>Your account</h1>
                        <p className="lede">Update your profile details and login password.</p>
                    </div>
                </header>

                <section className="grid-section">
                    <div className="section-heading">
                        <h2>Profile</h2>
                    </div>
                    <form className="settings-form" onSubmit={onProfileSubmit}>
                        <label className="auth-field">
                            <span>Display name</span>
                            <input
                                value={displayName}
                                onChange={(e) => setDisplayName(e.target.value)}
                                placeholder="Your display name"
                            />
                        </label>
                        <label className="auth-field">
                            <span>Email</span>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                            />
                        </label>
                        <button className="btn primary" type="submit" disabled={profileSaving}>
                            {profileSaving ? "Saving..." : "Save profile"}
                        </button>
                    </form>
                </section>

                <section className="grid-section">
                    <div className="section-heading">
                        <h2>Password</h2>
                    </div>
                    <form className="settings-form" onSubmit={onPasswordSubmit}>
                        <label className="auth-field">
                            <span>Current password</span>
                            <input
                                type="password"
                                value={currentPassword}
                                onChange={(e) => setCurrentPassword(e.target.value)}
                                autoComplete="current-password"
                                required
                            />
                        </label>
                        <label className="auth-field">
                            <span>New password</span>
                            <input
                                type="password"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                autoComplete="new-password"
                                required
                            />
                        </label>
                        <label className="auth-field">
                            <span>Confirm password</span>
                            <input
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                autoComplete="new-password"
                                required
                            />
                        </label>
                        <button className="btn primary" type="submit" disabled={passwordSaving}>
                            {passwordSaving ? "Updating..." : "Change password"}
                        </button>
                    </form>
                </section>

                {message && <div className="success-text">{message}</div>}
                {error && <div className="error-text">{error}</div>}
            </main>

            <aside className="sidebar right sticky">
                <div className="eyebrow">Account</div>
                <h3>{user?.display_name || user?.email || "User"}</h3>
                <p className="muted">{user?.is_admin ? "Admin account" : "Standard account"}</p>
                <p className="muted">
                    Joined {user?.created_at ? new Date(user.created_at).toLocaleDateString() : "-"}
                </p>
                <button className="btn third settings-logout" onClick={onLogout} type="button">
                    Logout
                </button>
            </aside>
        </div>
    );
}
