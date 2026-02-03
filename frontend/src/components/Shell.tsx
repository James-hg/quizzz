type Props = {
    children: React.ReactNode;
    primaryLabel?: string;
    primaryHref?: string;
};

export function Shell({
    children,
    primaryLabel = "Create quiz",
    // if in editor, change button to import
    primaryHref = "#/editor",
}: Props) {
    return (
        <div className="shell">
            <nav className="topbar">
                <a className="brand" href="#/">
                    Quizzz
                </a>
                <div className="topbar-actions">
                    <a className="nav-link" href={primaryHref}>
                        {primaryLabel}
                    </a>
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
