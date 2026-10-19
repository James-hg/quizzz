import { createAuthClient } from "better-auth/react";

/** Browser client for Better Auth. Sessions live in HTTP-only cookies, never in JS storage. */
export const authClient = createAuthClient();
