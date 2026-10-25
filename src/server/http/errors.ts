import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const unauthorized = (message = "Authentication required") =>
  new ApiError(401, "unauthorized", message);
/** Used for both missing and not-owned resources so existence is never leaked. */
export const notFound = (message = "Not found") => new ApiError(404, "not_found", message);
export const badRequest = (message: string, code = "bad_request") =>
  new ApiError(400, code, message);
export const conflict = (message: string, code = "conflict", details?: Record<string, unknown>) =>
  new ApiError(409, code, message, details);

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "validation_error",
          message: error.issues
            .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
            .join("; "),
        },
      },
      { status: 400 },
    );
  }
  console.error(error);
  return NextResponse.json(
    { error: { code: "internal_error", message: "Something went wrong" } },
    { status: 500 },
  );
}

/** Wraps a Route Handler so every failure uses the `{ error: { code, message } }` shape. */
export function handleRoute<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
