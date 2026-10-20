import type { ReactNode } from "react";
import { NavBar } from "@/components/NavBar";
import { requirePageUser } from "@/server/auth/page";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requirePageUser();
  return (
    <>
      <NavBar name={user.displayName ?? user.name} />
      <main id="main" className="page">
        {children}
      </main>
    </>
  );
}
