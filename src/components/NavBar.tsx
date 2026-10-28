import Link from "next/link";
import { SignOutButton } from "./SignOutButton";

export function NavBar({ name, loginDisabled = false }: { name: string; loginDisabled?: boolean }) {
  return (
    <header className="topbar">
      <nav aria-label="Main" className="topbar-inner">
        <Link href="/" className="brand">
          Quizzz
        </Link>
        <div className="topbar-actions">
          <Link href="/settings" className="nav-link">
            {name}
          </Link>
          {loginDisabled ? (
            <span className="badge badge-warn" title="AUTH_DISABLED is on: login is skipped">
              Login off
            </span>
          ) : (
            <SignOutButton />
          )}
        </div>
      </nav>
    </header>
  );
}
