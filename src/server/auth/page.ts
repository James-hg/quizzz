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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Reads a dynamic route param that must be a uuid; anything else is a not-found page. */
export async function idParam<K extends string>(
  params: Promise<Record<K, string>>,
  key: K,
): Promise<string> {
  const value = (await params)[key];
  if (!UUID.test(value)) notFound();
  return value;
}
