const ORIGIN = "http://localhost:3000";

export function authRequest(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
) {
  const headers = new Headers({ origin: ORIGIN });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** Turns a response's Set-Cookie headers into a Cookie header value. */
export function cookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => c && !c.endsWith("="))
    .join("; ");
}
