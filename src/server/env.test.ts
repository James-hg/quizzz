import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "./env";

const valid = {
  DATABASE_URL: "postgres://quizzz:quizzz@localhost:5432/quizzz",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  STORAGE_DIR: "./storage",
};

describe("parseEnv", () => {
  it("accepts a valid environment and defaults AI_PROVIDER to disabled", () => {
    const env = parseEnv(valid);
    expect(env.AI_PROVIDER).toBe("disabled");
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GEMINI_MODEL).toBeUndefined();
  });

  it("treats empty optional values as unset", () => {
    const env = parseEnv({
      ...valid,
      AI_PROVIDER: "gemini",
      GEMINI_API_KEY: "",
      GEMINI_MODEL: " ",
    });
    expect(env.AI_PROVIDER).toBe("gemini");
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GEMINI_MODEL).toBeUndefined();
  });

  it("names each missing required variable", () => {
    const { DATABASE_URL: _omit, ...rest } = valid;
    void _omit;
    expect(() => parseEnv(rest)).toThrow(EnvError);
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it("rejects an unknown AI_PROVIDER", () => {
    expect(() => parseEnv({ ...valid, AI_PROVIDER: "openai" })).toThrow(/AI_PROVIDER/);
  });

  it("rejects a short auth secret", () => {
    expect(() => parseEnv({ ...valid, BETTER_AUTH_SECRET: "short" })).toThrow(/BETTER_AUTH_SECRET/);
  });
});
