import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { getOptionalUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Sign in · Quizzz" };

export default async function Page() {
  if (await getOptionalUser()) redirect("/");
  return <AuthForm mode="sign-in" />;
}
