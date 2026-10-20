import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { getOptionalUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Create account · Quizzz" };

export default async function Page() {
  if (await getOptionalUser()) redirect("/");
  return <AuthForm mode="sign-up" />;
}
