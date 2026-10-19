import "server-only";
import { z } from "zod";
import { badRequest, notFound } from "./errors";

export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw badRequest("Request body must be JSON");
  }
  return schema.parse(json);
}

const uuid = z.uuid();

/** A malformed id can never match a row, so it is a 404 rather than a database error. */
export function parseId(value: string, label = "Resource"): string {
  if (!uuid.safeParse(value).success) throw notFound(`${label} not found`);
  return value;
}
