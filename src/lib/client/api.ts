/** Error from the app's own API: `{ error: { code, message, details? } }`. */
export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

type Options = { method?: string; body?: unknown; formData?: FormData; signal?: AbortSignal };

/** JSON fetch against our own API. Throws ApiClientError with a message safe to show. */
export async function apiFetch<T>(path: string, options: Options = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? (options.body !== undefined || options.formData ? "POST" : "GET"),
      headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body:
        options.formData ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      signal: options.signal,
      credentials: "same-origin",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiClientError(
      0,
      "network",
      "Could not reach the server. Check your connection and try again.",
    );
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    const error = (
      json as
        | { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
        | undefined
    )?.error;
    throw new ApiClientError(
      response.status,
      error?.code ?? "error",
      error?.message ?? "Something went wrong. Please try again.",
      error?.details,
    );
  }
  return json as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Please try again.";
}
