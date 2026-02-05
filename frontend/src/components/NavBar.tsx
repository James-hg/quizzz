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
    primaryHref = "/editor",
}: Props) {
    // const isPlayPage = window.location.hash.startsWith("play");

    return (
        <div className="NavBar">
            <nav className="topbar">
                <a className="brand" href="/">
                    Quizzz
                </a>
                <div className="topbar-actions">
                    {/* {!isPlayPage && ( */}
                    <a className="nav-link" href={primaryHref}>
                        {primaryLabel}
                    </a>
                    {/* )} */}
                    <a
                        className="user-btn"
                        href="/settings"
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
