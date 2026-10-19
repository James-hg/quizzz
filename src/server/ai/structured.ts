import { z } from "zod";
import { AiInvalidOutput } from "./errors";
import { toMessages, type AiMessage } from "./provider";

/** Models sometimes wrap JSON in a code fence; accept that but nothing else. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

export function schemaInstruction(schema: z.ZodType): string {
  return [
    "Reply with a single JSON value only, no prose and no code fences.",
    "It must match this JSON Schema:",
    JSON.stringify(z.toJSONSchema(schema)),
  ].join("\n");
}

function parseWith<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch {
    return { ok: false, error: "the reply was not valid JSON" };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const issue = result.error.issues[0];
  return {
    ok: false,
    error: `${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "does not match the schema"}`,
  };
}

/**
 * Runs `generate` (one raw model call), validates the result, and retries at most once with
 * the validation error. Provider-independent so every provider shares the same behavior.
 */
export async function structuredWithRepair<T>(
  generate: (messages: AiMessage[]) => Promise<string>,
  input: string | AiMessage[],
  schema: z.ZodType<T>,
): Promise<T> {
  const messages = toMessages(input);
  const first = await generate(messages);
  const parsed = parseWith(first, schema);
  if (parsed.ok) return parsed.value;

  const second = await generate([
    ...messages,
    { role: "assistant", content: first.slice(0, 2000) },
    {
      role: "user",
      content: `That reply was not usable: ${parsed.error}. Reply again with only the corrected JSON.`,
    },
  ]);
  const repaired = parseWith(second, schema);
  if (repaired.ok) return repaired.value;
  throw new AiInvalidOutput();
}
