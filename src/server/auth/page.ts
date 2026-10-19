import "server-only";
import { notFound, redirect } from "next/navigation";
import { ApiError } from "@/server/http/errors";
import { getOptionalUser, type SessionUser } from "./session";

/** For Server Component pages: the signed-in user, or a redirect to sign-in. */
export async function requirePageUser(): Promise<SessionUser> {
  const user = await getOptionalUser();
  if (!user) redirect("/sign-in");
  return user;
}

/** Runs a data read; a 404 from the ownership helpers becomes the app's not-found page. */
export async function orNotFound<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}
