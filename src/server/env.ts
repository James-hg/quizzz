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
  // Local-only escape hatch: skip login and act as a built-in local user. Refused in production.
  AUTH_DISABLED: z.preprocess(
    (value) =>
      typeof value === "string" ? ["1", "true", "yes"].includes(value.trim().toLowerCase()) : value,
    z.boolean().default(false),
  ),
  // Where sample course fixtures live (default: fixtures/sample-courses in the project).
  SAMPLES_DIR: optionalString,
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
  if (result.data.AUTH_DISABLED && source.NODE_ENV === "production") {
    // Skipping login on a server that other people can reach would hand them every account's data.
    throw new EnvError([
      "AUTH_DISABLED: login cannot be turned off when NODE_ENV=production. Unset it, or run `npm run dev`.",
    ]);
  }
  return result.data;
}

let cached: Env | undefined;

/** Parsed process env, validated on first use. Throws EnvError naming each bad variable. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
