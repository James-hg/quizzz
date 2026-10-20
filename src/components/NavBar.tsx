import Link from "next/link";
import { SignOutButton } from "./SignOutButton";

export function NavBar({ name }: { name: string }) {
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
          <SignOutButton />
        </div>
      </nav>
    </header>
  );
}
