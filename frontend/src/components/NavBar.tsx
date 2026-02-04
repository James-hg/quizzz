import { ReactNode, useEffect, useState } from "react";

type Props = {
    children: ReactNode;
    primaryLabel?: string;
    primaryHref?: string;
    onSaveExit?: () => void;
};

export function NavBar({
    children,
    primaryLabel = "Create quiz",
    // if in editor, change button to import
    primaryHref = "#/editor",
    onSaveExit,
}: Props) {
    const isPlayPage = window.location.hash.startsWith("#/play");
    const [menuOpen, setMenuOpen] = useState(false);

    // close dropdown when route changes (hash change) to avoid stale open state
    useEffect(() => {
        const handleHash = () => setMenuOpen(false);
        window.addEventListener("hashchange", handleHash);
        return () => window.removeEventListener("hashchange", handleHash);
    }, []);

    return (
        <div className="NavBar">
            <nav className="topbar">
                <a className="brand" href="#/">
                    Quizzz
                </a>
                <div className="topbar-actions">
                    {isPlayPage && (
                        <div className="play-menu">
                            <button
                                className="kebab"
                                onClick={() => setMenuOpen((v) => !v)}
                                aria-label="Open menu"
                            >
                                ⋮⋮⋮
                            </button>
                            {menuOpen && (
                                <div className="dropdown">
                                    <button
                                        className="dropdown-item"
                                        onClick={() =>
                                            (window.location.hash = "/")
                                        }
                                    >
                                        Home
                                    </button>
                                    <button
                                        className="dropdown-item"
                                        onClick={() => {
                                            onSaveExit?.();
                                            setMenuOpen(false);
                                        }}
                                    >
                                        Save & exit
                                    </button>
                                    <button
                                        className="dropdown-item"
                                        onClick={() => setMenuOpen(false)}
                                    >
                                        Resume
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    {!isPlayPage && (
                        <a className="nav-link" href={primaryHref}>
                            {primaryLabel}
                        </a>
                    )}
                    <a
                        className="user-btn"
                        href="#/settings"
                        aria-label="User settings"
                    >
                        <div className="avatar">U</div>
                    </a>
                </div>
            </nav>
            {children}
        </div>
    );
}
