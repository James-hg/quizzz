import { authRequest } from "./auth-helpers";
import type { TestUser } from "./users";

type Handler = (request: Request, ctx: { params: Promise<never> }) => Promise<Response>;

export type CallOptions = {
  method?: string;
  body?: unknown;
  as?: TestUser | null;
  params?: Record<string, string>;
};

/** Invokes a Route Handler directly with a signed-in user's cookie. */
export async function call(
  handler: unknown,
  path: string,
  as: TestUser | null,
  options: CallOptions = {},
) {
  const request = authRequest(path, {
    method: options.method,
    body: options.body,
    cookie: as?.cookie,
  });
  const response = await (handler as Handler)(request, {
    params: Promise.resolve((options.params ?? {}) as never),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}
