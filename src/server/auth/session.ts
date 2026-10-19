import "server-only";
import { headers } from "next/headers";
import { getAuth } from "./index";
import { unauthorized } from "@/server/http/errors";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  timezone: string;
};

async function userFromHeaders(requestHeaders: Headers): Promise<SessionUser | null> {
  const result = await getAuth().api.getSession({ headers: requestHeaders });
  if (!result) return null;
  const u = result.user as typeof result.user & { displayName?: string | null; timezone?: string };
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    displayName: u.displayName ?? null,
    timezone: u.timezone ?? "UTC",
  };
}

/** For Route Handlers: the signed-in user, or a typed 401 (missing or expired session). */
export async function requireUser(request: Request): Promise<SessionUser> {
  const user = await userFromHeaders(request.headers);
  if (!user) throw unauthorized();
  return user;
}

/** For Server Components and actions: the signed-in user, or null. */
export async function getOptionalUser(): Promise<SessionUser | null> {
  return userFromHeaders(await headers());
}
