import "server-only";
import { z } from "zod";

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1).pipe(z.url()),
  BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
  BETTER_AUTH_URL: z.url(),
  AI_PROVIDER: z.enum(["gemini", "disabled"]).default("disabled"),
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: optionalString,
  STORAGE_DIR: z.string().min(1),
  AI_REQUESTS_PER_HOUR: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().positive().default(30),
  ),
  MAX_UPLOAD_BYTES: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
  ),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "EnvError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return result.data;
}

let cached: Env | undefined;

/** Parsed process env, validated on first use. Throws EnvError naming each bad variable. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
