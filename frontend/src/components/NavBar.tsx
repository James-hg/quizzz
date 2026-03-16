import { ReactNode } from "react";

type User = {
    email: string;
    display_name: string | null;
};

type Props = {
    children: ReactNode;
    primaryLabel?: string;
    primaryHref?: string;
    user: User | null;
};

export function NavBar({
    children,
    primaryLabel = "Create quiz",
    primaryHref = "/editor",
    user,
}: Props) {
    const avatarLabel = (user?.display_name || user?.email || "U").trim().charAt(0).toUpperCase();

    return (
        <div className="NavBar">
            <nav className="topbar">
                <a className="brand" href="/">
                    Quizzz
                </a>
                <div className="topbar-actions">
                    <a className="nav-link" href={primaryHref}>
                        {primaryLabel}
                    </a>
                    <a className="user-btn" href="/settings" aria-label="User settings">
                        <div className="avatar">{avatarLabel || "U"}</div>
                    </a>
                </div>
            </nav>
            {children}
        </div>
    );
}
